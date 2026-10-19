// Agent 循环:目标 → 模型自己规划调哪个工具 → 执行 → 结果回填 → 再决定……
//
// 与宝可梦项目的单轮 Function Calling 不同,这里没有写死的流水线——
// 「先 git log 再总结」的顺序完全由模型在 system prompt 的 rubric 约束下
// 自主决定。代码只守四条硬边界:
//   1. 轮次上限 MAX_ROUNDS:防失控螺旋(反复查同一仓库、无限展开);
//   2. token 预算上限:防烧钱螺旋——事后计量 + 轮前闸(真值优先,GLM
//      usage 缺失时字符/2 估算兜底);超限不报错,强制进入收尾模式;
//   3. 工具失败作为观察结果回给模型(错误是数据,不是异常)——让它自己
//      决定跳过还是换路,这是 Agent 韧性的落点;
//   4. 收尾模式工具白名单:只允许 save_draft——system prompt 说"不要再
//      收集"是君子协定,代码层面直接拒收收集类调用,双保险;
//   触顶(轮次或 token)一律带已有材料强制收尾,不许静默截断(降级必须
//   带 reason)。每轮全部进审计日志,决策可回放。

import { AuditLog } from './audit.js';
import type { ChatModel } from './llm.js';
import { estimateTokens } from './llm.js';
import { buildTools, type ToolContext } from './tools.js';
import type { AppConfig, ChatResponse, LlmMessage, ToolCallRequest, ToolDef, ToolResult } from './types.js';
import * as nodePath from 'node:path';

export const DEFAULT_MAX_ROUNDS = 8;
/** 收尾模式额外给的轮数(只允许用来保存草稿) */
const CLOSING_ROUNDS = 2;
const DEFAULT_TOKEN_BUDGET = 60_000;

export interface RunOptions {
  config: AppConfig;
  model: ChatModel;
  since: string;
  maxRounds?: number;
  /** 运行级 token 预算;缺省读 WRA_TOKEN_BUDGET,再缺省 60k */
  tokenBudget?: number;
  /** E2E 注入临时目录用;缺省落到项目根的 drafts/ 与 audit/ */
  paths?: { draftsDir?: string; auditDir?: string };
  /** CLI 进度展示用(E2E 不传) */
  onEvent?: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'round'; round: number; closing: boolean }
  | { type: 'tool'; round: number; name: string; ok: boolean };

export interface RunResult {
  status: 'draft_saved' | 'no_draft' | 'error';
  draftPath?: string;
  /** 实际发生的模型调用轮数(含收尾轮) */
  rounds: number;
  auditFile: string;
  errorMessage?: string;
  /** 本次运行累计 token(真值优先,估算兜底) */
  tokensUsed?: number;
  /** token 预算是否触顶(触顶后强制收尾,草稿可能基于不完整材料) */
  budgetExceeded?: boolean;
}

function envBudget(): number {
  const n = Number(process.env['WRA_TOKEN_BUDGET']);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TOKEN_BUDGET;
}

export async function runWeeklyAgent(opts: RunOptions): Promise<RunResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const tokenBudget = opts.tokenBudget ?? envBudget();
  const draftsDir = opts.paths?.draftsDir ?? nodePath.resolve('drafts');
  const auditDir = opts.paths?.auditDir ?? nodePath.resolve('audit');

  const ctx: ToolContext = { repos: opts.config.repos, draftsDir };
  const tools: ToolDef[] = buildTools(ctx);

  const audit = AuditLog.start(auditDir, {
    model: opts.model.name,
    since: opts.since,
    maxRounds,
    tokenBudget,
    repos: opts.config.repos.map(r => r.name),
  });

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(opts.config) },
    { role: 'user', content: `请生成一份周报草稿,统计时间段:自 ${opts.since} 以来。今天是 ${new Date().toISOString().slice(0, 10)}。` },
  ];

  let draftPath: string | null = null;
  let rounds = 0;
  let tokensUsed = 0;
  let budgetExceeded = false;
  let textTurnsWithoutSave = 0;
  let finish: RunResult | null = null;
  const emit = opts.onEvent ?? (() => {});

  const settle = (r: RunResult): void => { if (!finish) finish = r; };

  /** 记账:GLM usage 真值优先,缺失按字符/2 估算(只兜 prompt 文本 + 输出文本,量级护栏) */
  const meter = (res: ChatResponse, msgs: LlmMessage[]): { prompt: number; completion: number } => {
    const u = res.usage ?? {
      prompt: estimateTokens(...msgs.map(m => String(m.content ?? ''))),
      completion: estimateTokens(res.text),
    };
    tokensUsed += u.prompt + u.completion;
    return u;
  };

  // ---- 主循环 -------------------------------------------------------------
  for (let round = 1; round <= maxRounds && !finish; round++) {
    // 轮前闸:上一轮烧完的 token 已超预算 → 立刻转收尾(本轮不再发起调用)
    if (tokensUsed > tokenBudget) { budgetExceeded = true; break; }
    rounds = round;
    emit({ type: 'round', round, closing: false });
    let res: ChatResponse;
    try {
      res = await opts.model.chat(messages, tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      settle({ status: 'error', rounds, auditFile: audit.file, errorMessage: `模型调用失败:${msg}`, tokensUsed, budgetExceeded });
      break;
    }
    const usage = meter(res, messages);
    audit.write({ type: 'model_round', round, closing: false, usage: { ...usage, cumulative: tokensUsed }, text: res.text.slice(0, 2000), tool_calls: auditCalls(res.toolCalls) });

    if (res.toolCalls.length === 0) {
      if (draftPath) { settle({ status: 'draft_saved', draftPath, rounds, auditFile: audit.file, tokensUsed, budgetExceeded }); break; }
      textTurnsWithoutSave++;
      if (textTurnsWithoutSave >= 2) {
        settle({ status: 'no_draft', rounds, auditFile: audit.file, errorMessage: '模型连续两轮只输出文本、未保存草稿', tokensUsed, budgetExceeded });
        break;
      }
      messages.push(
        { role: 'assistant', content: res.text },
        { role: 'user', content: '你还没有保存草稿。材料足够请立即调用 save_draft;不足请继续用工具收集。' },
      );
      continue;
    }

    textTurnsWithoutSave = 0;
    const outcomes = await executeCalls(res.toolCalls, tools, audit, round, false);
    pushAssistantAndResults(messages, res, outcomes);
    for (const o of outcomes) emit({ type: 'tool', round, name: o.call.function.name, ok: o.result.ok });

    for (const o of outcomes) {
      if (o.call.function.name === 'save_draft' && o.result.ok && o.result.draftPath) draftPath = o.result.draftPath;
    }
    if (draftPath) { settle({ status: 'draft_saved', draftPath, rounds, auditFile: audit.file, tokensUsed, budgetExceeded }); break; }
  }

  // ---- 触顶收尾:带着已有材料保存,不许静默截断 ----------------------------
  if (!finish && !draftPath) {
    const reason = budgetExceeded
      ? `token 预算已达上限(约 ${tokensUsed} tokens,预算 ${tokenBudget})`
      : `轮次已达上限(${maxRounds})`;
    messages.push({
      role: 'user',
      content: `${reason}。请立即基于已收集的材料调用 save_draft 保存周报草稿;材料缺口如实写进「未竟事项」;不要再调用收集类工具。`,
    });
    for (let i = 1; i <= CLOSING_ROUNDS && !finish; i++) {
      rounds++;
      emit({ type: 'round', round: rounds, closing: true });
      let res: ChatResponse;
      try {
        res = await opts.model.chat(messages, tools);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        settle({ status: 'error', rounds, auditFile: audit.file, errorMessage: `收尾阶段模型调用失败:${msg}`, tokensUsed, budgetExceeded });
        break;
      }
      const usage = meter(res, messages);
      audit.write({ type: 'model_round', round: rounds, closing: true, usage: { ...usage, cumulative: tokensUsed }, text: res.text.slice(0, 2000), tool_calls: auditCalls(res.toolCalls) });

      if (res.toolCalls.length === 0) {
        messages.push(
          { role: 'assistant', content: res.text },
          { role: 'user', content: '仍未保存。请立即调用 save_draft(title, md) 保存草稿,这是收尾的唯一目标。' },
        );
        continue;
      }
      // 收尾轮也执行 save_draft 之外的调用(代码白名单会拒绝),把拒绝原因
      // 回给模型让它纠正——守卫是边界,回填是教育。
      const outcomes = await executeCalls(res.toolCalls, tools, audit, rounds, true);
      pushAssistantAndResults(messages, res, outcomes);
      for (const o of outcomes) emit({ type: 'tool', round: rounds, name: o.call.function.name, ok: o.result.ok });
      for (const o of outcomes) {
        if (o.call.function.name === 'save_draft' && o.result.ok && o.result.draftPath) draftPath = o.result.draftPath;
      }
      if (draftPath) { settle({ status: 'draft_saved', draftPath, rounds, auditFile: audit.file, tokensUsed, budgetExceeded }); }
    }
  }

  const result: RunResult = finish ?? {
    status: draftPath ? 'draft_saved' : 'no_draft',
    draftPath: draftPath ?? undefined,
    rounds,
    auditFile: audit.file,
    errorMessage: draftPath ? undefined : `已达轮次或 token 上限(${rounds} 轮,约 ${tokensUsed} tokens)仍未保存草稿`,
    tokensUsed,
    budgetExceeded,
  };
  audit.write({ type: 'run_end', status: result.status, rounds, draftPath: result.draftPath ?? null, error: result.errorMessage ?? null, tokens_used: tokensUsed, budget_exceeded: budgetExceeded });
  return result;
}

// ---- 循环内部件 -------------------------------------------------------------

function systemPrompt(config: AppConfig): string {
  return [
    '你是周报撰写 Agent:基于本地仓库的真实材料写一篇周报 markdown 草稿,最后调用 save_draft 保存。',
    '',
    '## 可用材料',
    `本地仓库清单(名称、路径、说明)用 list_repos 工具查看,共 ${config.repos.length} 个。`,
    '',
    '## 写作 rubric',
    config.rubric,
    '',
    '## 工作纪律',
    '1. 执行顺序由你自己规划:先想清楚需要哪些材料(哪些仓库的提交记录、哪些文件),逐步收集;材料够了就写,不要为收集而收集。',
    '2. 一切事实(hash、日期、标题、数字)必须来自工具返回,禁止凭记忆编造;材料不足在草稿里如实注明。',
    '3. 工具失败不是致命错误:把错误信息当作观察结果,决定跳过还是换路;不要对同一失败调用原样重试。',
    '4. 材料收集完成后必须调用 save_draft 保存草稿,这是本次任务的完成标志。',
  ].join('\n');
}

interface CallOutcome {
  call: ToolCallRequest;
  result: ToolResult;
}

async function executeCalls(calls: ToolCallRequest[], tools: ToolDef[], audit: AuditLog, round: number, closing: boolean): Promise<CallOutcome[]> {
  return Promise.all(calls.map(async (call): Promise<CallOutcome> => {
    const result = await execOne(call, tools, closing);
    audit.write({ type: 'tool_result', round, closing, name: call.function.name, ok: result.ok, result: truncateResult(result) });
    return { call, result };
  }));
}

async function execOne(call: ToolCallRequest, tools: ToolDef[], closing: boolean): Promise<ToolResult> {
  // 收尾模式白名单:预算已尽还去收集材料 = 违反收尾契约。prompt 里说了
  // "不要再收集",这里用代码兜底——君子协定 + 代码拦截,双保险。
  if (closing && call.function.name !== 'save_draft') {
    return { ok: false, error: '收尾模式:只允许调用 save_draft(轮次或 token 预算已尽,禁止再收集材料)', hint: '立即用已有材料调用 save_draft 收尾' };
  }
  const def = tools.find(t => t.name === call.function.name);
  if (!def) {
    return { ok: false, error: `未知工具:${call.function.name}`, hint: '可用工具:list_repos / git_log / read_file / save_draft' };
  }
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '工具参数必须是 JSON 对象' };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: `工具参数不是合法 JSON:${call.function.arguments.slice(0, 100)}` };
  }
  try {
    return await def.execute(args);
  } catch (err) {
    return { ok: false, error: `工具内部错误:${err instanceof Error ? err.message : err}`, hint: '可换路或跳过' };
  }
}

/** 按 API 契约回填:assistant(tool_calls) 必须紧跟它各自的 tool 消息 */
function pushAssistantAndResults(messages: LlmMessage[], res: ChatResponse, outcomes: CallOutcome[]): void {
  messages.push({
    role: 'assistant',
    content: res.text || null,
    tool_calls: outcomes.map(o => ({ id: o.call.id, type: 'function' as const, function: o.call.function })),
  });
  for (const o of outcomes) {
    messages.push({
      role: 'tool',
      tool_call_id: o.call.id,
      content: JSON.stringify(o.result.ok ? { ok: true, data: o.result.data } : { ok: false, error: o.result.error, hint: o.result.hint }),
    });
  }
}

function auditCalls(calls: ToolCallRequest[]): Array<{ id: string; name: string; arguments: unknown }> {
  return calls.map(c => {
    let args: unknown = c.function.arguments;
    try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* 原样记录 */ }
    return { id: c.id, name: c.function.name, arguments: args };
  });
}

function truncateResult(result: ToolResult): Record<string, unknown> {
  if (!result.ok) return { error: result.error, hint: result.hint };
  const data = result.data ?? '';
  return { data: data.length > 4000 ? `${data.slice(0, 4000)}…(审计截断)` : data, draftPath: result.draftPath };
}
