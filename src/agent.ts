// Agent 循环:目标 → 模型自己规划调哪个工具 → 执行 → 结果回填 → 再决定……
//
// 与宝可梦项目的单轮 Function Calling 不同,这里没有写死的流水线——
// 「先 git log 再总结」的顺序完全由模型在 system prompt 的 rubric 约束下
// 自主决定。代码只守三条硬边界:
//   1. 轮次上限 MAX_ROUNDS:防失控螺旋;触顶后带已有材料进入收尾模式,
//      不许静默截断(历史教训:降级路径必须带 reason);
//   2. 工具失败作为观察结果回给模型(错误是数据,不是异常)——让它自己
//      决定跳过还是换路,这是 Agent 韧性的落点;
//   3. 每轮全部进审计日志,决策可回放。

import { AuditLog } from './audit.js';
import type { ChatModel } from './llm.js';
import { buildTools, type ToolContext } from './tools.js';
import type { AppConfig, ChatResponse, LlmMessage, ToolCallRequest, ToolDef, ToolResult } from './types.js';
import * as nodePath from 'node:path';

export const DEFAULT_MAX_ROUNDS = 8;
/** 收尾模式额外给的轮数(只允许用来保存草稿) */
const CLOSING_ROUNDS = 2;

export interface RunOptions {
  config: AppConfig;
  model: ChatModel;
  since: string;
  maxRounds?: number;
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
}

export async function runWeeklyAgent(opts: RunOptions): Promise<RunResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const draftsDir = opts.paths?.draftsDir ?? nodePath.resolve('drafts');
  const auditDir = opts.paths?.auditDir ?? nodePath.resolve('audit');

  const ctx: ToolContext = { repos: opts.config.repos, draftsDir };
  const tools: ToolDef[] = buildTools(ctx);

  const audit = AuditLog.start(auditDir, {
    model: opts.model.name,
    since: opts.since,
    maxRounds,
    repos: opts.config.repos.map(r => r.name),
  });

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(opts.config) },
    { role: 'user', content: `请生成一份周报草稿,统计时间段:自 ${opts.since} 以来。今天是 ${new Date().toISOString().slice(0, 10)}。` },
  ];

  let draftPath: string | null = null;
  let rounds = 0;
  let textTurnsWithoutSave = 0;
  let finish: RunResult | null = null;
  const emit = opts.onEvent ?? (() => {});

  const settle = (r: RunResult): void => { if (!finish) finish = r; };

  // ---- 主循环 -------------------------------------------------------------
  for (let round = 1; round <= maxRounds && !finish; round++) {
    rounds = round;
    emit({ type: 'round', round, closing: false });
    let res: ChatResponse;
    try {
      res = await opts.model.chat(messages, tools);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      settle({ status: 'error', rounds, auditFile: audit.file, errorMessage: `模型调用失败:${msg}` });
      break;
    }
    audit.write({ type: 'model_round', round, closing: false, text: res.text.slice(0, 2000), tool_calls: auditCalls(res.toolCalls) });

    if (res.toolCalls.length === 0) {
      if (draftPath) { settle({ status: 'draft_saved', draftPath, rounds, auditFile: audit.file }); break; }
      textTurnsWithoutSave++;
      if (textTurnsWithoutSave >= 2) {
        settle({ status: 'no_draft', rounds, auditFile: audit.file, errorMessage: '模型连续两轮只输出文本、未保存草稿' });
        break;
      }
      messages.push(
        { role: 'assistant', content: res.text },
        { role: 'user', content: '你还没有保存草稿。材料足够请立即调用 save_draft;不足请继续用工具收集。' },
      );
      continue;
    }

    textTurnsWithoutSave = 0;
    const outcomes = await executeCalls(res.toolCalls, tools, audit, round);
    pushAssistantAndResults(messages, res, outcomes);
    for (const o of outcomes) emit({ type: 'tool', round, name: o.call.function.name, ok: o.result.ok });

    for (const o of outcomes) {
      if (o.call.function.name === 'save_draft' && o.result.ok && o.result.draftPath) draftPath = o.result.draftPath;
    }
    if (draftPath) { settle({ status: 'draft_saved', draftPath, rounds, auditFile: audit.file }); break; }
  }

  // ---- 触顶收尾:带着已有材料保存,不许静默截断 ----------------------------
  if (!finish && !draftPath) {
    messages.push({
      role: 'user',
      content: `轮次已达上限(${maxRounds})。请立即基于已收集的材料调用 save_draft 保存周报草稿;材料缺口如实写进「未竟事项」;不要再调用收集类工具。`,
    });
    for (let i = 1; i <= CLOSING_ROUNDS && !finish; i++) {
      rounds++;
      emit({ type: 'round', round: rounds, closing: true });
      let res: ChatResponse;
      try {
        res = await opts.model.chat(messages, tools);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        settle({ status: 'error', rounds, auditFile: audit.file, errorMessage: `收尾阶段模型调用失败:${msg}` });
        break;
      }
      audit.write({ type: 'model_round', round: rounds, closing: true, text: res.text.slice(0, 2000), tool_calls: auditCalls(res.toolCalls) });

      if (res.toolCalls.length === 0) {
        messages.push(
          { role: 'assistant', content: res.text },
          { role: 'user', content: '仍未保存。请立即调用 save_draft(title, md) 保存草稿,这是收尾的唯一目标。' },
        );
        continue;
      }
      const outcomes = await executeCalls(res.toolCalls, tools, audit, rounds);
      pushAssistantAndResults(messages, res, outcomes);
      for (const o of outcomes) emit({ type: 'tool', round: rounds, name: o.call.function.name, ok: o.result.ok });
      for (const o of outcomes) {
        if (o.call.function.name === 'save_draft' && o.result.ok && o.result.draftPath) draftPath = o.result.draftPath;
      }
      if (draftPath) { settle({ status: 'draft_saved', draftPath, rounds, auditFile: audit.file }); }
    }
  }

  const result: RunResult = finish ?? {
    status: draftPath ? 'draft_saved' : 'no_draft',
    draftPath: draftPath ?? undefined,
    rounds,
    auditFile: audit.file,
    errorMessage: draftPath ? undefined : `已达轮次上限(${rounds} 轮)仍未保存草稿`,
  };
  audit.write({ type: 'run_end', status: result.status, rounds, draftPath: result.draftPath ?? null, error: result.errorMessage ?? null });
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

async function executeCalls(calls: ToolCallRequest[], tools: ToolDef[], audit: AuditLog, round: number): Promise<CallOutcome[]> {
  return Promise.all(calls.map(async (call): Promise<CallOutcome> => {
    const result = await execOne(call, tools);
    audit.write({ type: 'tool_result', round, name: call.function.name, ok: result.ok, result: truncateResult(result) });
    return { call, result };
  }));
}

async function execOne(call: ToolCallRequest, tools: ToolDef[]): Promise<ToolResult> {
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
