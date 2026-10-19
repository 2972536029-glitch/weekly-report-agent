// CLI 入口:
//   npm run weekly -- --since "7 days ago" [--max-rounds N]   生成周报草稿
//   npm run review                                             打印最新草稿 + 审计摘要
//   npm run accept -- [draft.md]                               hash 门禁通过后收录进 reports/
//   npm run history                                            历史运行与草稿状态一览
//
// 边界(与任务说明红线一致):weekly/review/check-hash 只读或只写 drafts/;
// accept 把「核对」自动化(hash 校验)但「决定」留给人——命令由人敲,
// Agent 在循环里永远不会自推草稿。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { runWeeklyAgent } from './agent.js';
import { createGlmModel } from './llm.js';
import { acceptDraft } from './reports.js';
import type { AppConfig } from './types.js';

const argv = process.argv.slice(2);

if (argv.includes('--review')) {
  await reviewMode();
} else if (argv.includes('--accept')) {
  acceptMode();
} else if (argv.includes('--history')) {
  historyMode();
} else {
  await weeklyMode();
}

// ---- weekly -----------------------------------------------------------------

async function weeklyMode(): Promise<void> {
  const since = argValue('--since') ?? '7 days ago';
  const mr = argValue('--max-rounds');
  const maxRounds = Number.isFinite(Number(mr)) && Number(mr) >= 1 && Number(mr) <= 20
    ? Math.floor(Number(mr))
    : undefined;
  let config: AppConfig;
  try {
    config = loadConfig(nodePath.resolve('config.json'));
  } catch (err) {
    console.error(`config.json 无效:${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  const model = createGlmModel();
  // 模型名从 model.name 取而非直接读 env:GLM_MODEL 的 .env 解析发生在
  // createGlmModel 内部(惰性加载),提前读 process.env 会拿到未加载的值
  console.error(`周报 Agent 启动:model=${model.name} since="${since}"`);
  console.error(`材料范围:${config.repos.map(r => r.name).join(', ')}`);

  // 启动期仓库体检:只警告不拦截——路径暂时缺失正是 Agent 韧性的用武之地
  // (工具错误会回给模型让它绕开),提前 fail-fast 反而剥夺了这个能力。
  for (const r of config.repos) {
    if (!existsSync(r.path)) console.error(`⚠ 仓库路径不存在(工具将返回错误,Agent 会自行绕开):${r.name} → ${r.path}`);
  }

  const result = await runWeeklyAgent({
    config,
    model,
    since,
    maxRounds,
    onEvent: (e) => {
      if (e.type === 'round') {
        console.error(e.closing ? `\n[第 ${e.round} 轮·收尾模式]` : `\n[第 ${e.round} 轮]`);
      } else {
        console.error(`  ${e.ok ? '✓' : '✗'} ${e.name}`);
      }
    },
  });

  console.error('');
  if (result.status === 'draft_saved' && result.draftPath) {
    console.error(`草稿已保存:${result.draftPath}(共 ${result.rounds} 轮,token 约 ${result.tokensUsed ?? 0})`);
    if (result.budgetExceeded) {
      console.error('⚠ token 预算触顶,已强制收尾——草稿可能基于不完整材料,review 时重点看「未竟事项」');
    }
    console.error('下一步(人工 review,Agent 不代劳):');
    console.error('  1. npm run review            查看草稿与审计摘要');
    console.error('  2. npm run check-hash        校验草稿里的提交 hash 真实存在');
    console.error('  3. 认可后 npm run accept -- <草稿路径> 收录进 reports/;不认可改到认可为止');
    process.exitCode = 0;
  } else {
    console.error(`运行未产出草稿(${result.status},${result.rounds} 轮,token 约 ${result.tokensUsed ?? 0}):${result.errorMessage ?? '原因见审计日志'}`);
    console.error(`审计日志:${result.auditFile}`);
    process.exitCode = 1;
  }
}

// ---- review -----------------------------------------------------------------

async function reviewMode(): Promise<void> {
  const draft = latestFile(nodePath.resolve('drafts'), '.md');
  if (!draft) {
    console.error('drafts/ 里还没有草稿。先跑:npm run weekly -- --since "7 days ago"');
    process.exitCode = 1;
    return;
  }
  console.log('='.repeat(60));
  console.log(`草稿:${nodePath.basename(draft)}`);
  console.log('='.repeat(60));
  console.log(readFileSync(draft, 'utf8'));

  const auditFile = latestFile(nodePath.resolve('audit'), '.jsonl');
  if (auditFile) {
    console.log('='.repeat(60));
    console.log(`审计摘要(${nodePath.basename(auditFile)})`);
    console.log('='.repeat(60));
    for (const line of readFileSync(auditFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (e['type'] === 'model_round') {
        const calls = (e['tool_calls'] as Array<{ name: string }>) ?? [];
        const usage = e['usage'] as { cumulative?: number } | undefined;
        const what = calls.length > 0 ? calls.map(c => c.name).join(' + ') : '(纯文本,未调工具)';
        const tok = usage?.cumulative !== undefined ? `,累计 token ${usage.cumulative}` : '';
        console.log(`  第 ${String(e['round'])} 轮${e['closing'] ? '(收尾)' : ''}: ${what}${tok}`);
      } else if (e['type'] === 'tool_result') {
        console.log(`    ↳ ${e['name']} → ${e['ok'] ? 'ok' : '失败(错误已回给模型)'}`);
      } else if (e['type'] === 'run_end') {
        console.log(`  结束:${String(e['status'])},共 ${String(e['rounds'])} 轮,token 约 ${String(e['tokens_used'])}${e['budget_exceeded'] ? '(预算触顶)' : ''}`);
      }
    }
  } else {
    console.log('(没有找到审计日志)');
  }

  console.log('='.repeat(60));
  console.log('人工核对清单:');
  console.log('  1. 草稿里每个 hash 是否真实:npm run check-hash');
  console.log('  2. 提交归类、学习增量是否符合你的实际工作');
  console.log('  3. 认可后 npm run accept -- <草稿路径>;这是你的周报,不是 Agent 的');
}

// ---- accept -----------------------------------------------------------------

function acceptMode(): void {
  let config: AppConfig;
  try {
    config = loadConfig(nodePath.resolve('config.json'));
  } catch (err) {
    console.error(`config.json 无效:${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  const arg = argValue('--accept');
  const draftPath = arg && !arg.startsWith('--')
    ? nodePath.resolve(arg)
    : latestFile(nodePath.resolve('drafts'), '.md');
  if (!draftPath) {
    console.error('drafts/ 里没有草稿可收录。先生成:npm run weekly -- --since "7 days ago"');
    process.exitCode = 1;
    return;
  }
  const outcome = acceptDraft(draftPath, config);
  console.error((outcome.ok ? '✓ ' : '✗ ') + outcome.message);
  process.exitCode = outcome.ok ? 0 : 1;
}

// ---- history ----------------------------------------------------------------

function historyMode(): void {
  // 运行历史从 audit JSONL 现算——append-only 日志即唯一事实源,不另维护
  // 状态文件(两份状态迟早不一致,这是"单一源"原则的低成本兑现)。
  const auditDir = nodePath.resolve('audit');
  const runs: Array<{ file: string; start?: Record<string, unknown>; end?: Record<string, unknown> }> = [];
  let files: string[] = [];
  try { files = readdirSync(auditDir).filter(f => f.endsWith('.jsonl')); } catch { /* 无审计 */ }
  for (const f of files) {
    let start: Record<string, unknown> | undefined;
    let end: Record<string, unknown> | undefined;
    for (const line of readFileSync(nodePath.join(auditDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e['type'] === 'run_start') start = e;
        else if (e['type'] === 'run_end') end = e;
      } catch { /* 跳过损坏行 */ }
    }
    runs.push({ file: f, start, end });
  }
  runs.sort((a, b) => String(b.start?.['time'] ?? b.file).localeCompare(String(a.start?.['time'] ?? a.file)));

  console.log(`运行历史(最近 ${Math.min(10, runs.length)} 次,共 ${runs.length} 次):`);
  if (runs.length === 0) console.log('  (还没有运行记录)');
  for (const r of runs.slice(0, 10)) {
    const time = String(r.start?.['time'] ?? '?').slice(0, 19).replace('T', ' ');
    const model = String(r.start?.['model'] ?? '?');
    const since = String(r.start?.['since'] ?? '?');
    const status = r.end ? String(r.end['status']) : '(中断)';
    const rounds = r.end ? String(r.end['rounds']) : '-';
    const tokens = r.end ? String(r.end['tokens_used'] ?? '-') : '-';
    const flag = r.end?.['budget_exceeded'] ? ' ⚠预算' : '';
    console.log(`  ${time}  ${model.padEnd(12)} since="${since}"  ${String(status).padEnd(12)} ${rounds} 轮  token ${tokens}${flag}`);
  }

  const drafts = listMd('drafts');
  console.log(`\n草稿:待 review ${drafts.length} 份${drafts.length > 0 ? `(${drafts.slice(0, 5).join(', ')}${drafts.length > 5 ? ' …' : ''})` : ''}`);
  const reports = listMd('reports');
  const idx = existsSync(nodePath.resolve('reports', 'index.md'))
    ? readFileSync(nodePath.resolve('reports', 'index.md'), 'utf8').split('\n').filter(l => l.startsWith('- ')).length
    : 0;
  console.log(`周报:已收录 ${reports.length} 份(index.md ${idx} 条)`);
}

// ---- 公共 -------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loadConfig(file: string): AppConfig {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as AppConfig;
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) throw new Error('repos 必须是非空数组');
  for (const r of raw.repos) {
    if (!r.name || !r.path) throw new Error('每个 repo 必须有 name 和 path');
  }
  if (typeof raw.rubric !== 'string' || !raw.rubric.trim()) throw new Error('rubric 不能为空');
  return raw;
}

function latestFile(dir: string, ext: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(ext));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const newest = files
    .map(f => ({ f, m: statSync(nodePath.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]!.f;
  return nodePath.join(dir, newest);
}

function listMd(dir: string): string[] {
  try {
    return readdirSync(nodePath.resolve(dir)).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
}
