// CLI 入口:
//   npm run weekly -- --since "7 days ago"   生成周报草稿
//   npm run review                            打印最新草稿 + 审计摘要,提醒人工核对
//
// --review 只做「展示 + 提醒」,不代做任何核对动作之外的事——呼应
// 「AI 生成 + 人工逐行 review」的人设:Agent 停在用户面前,绝不自动提交。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { runWeeklyAgent } from './agent.js';
import { createGlmModel } from './llm.js';
import type { AppConfig } from './types.js';

const argv = process.argv.slice(2);

if (argv.includes('--review')) {
  await reviewMode();
} else {
  await weeklyMode();
}

// ---- weekly -----------------------------------------------------------------

async function weeklyMode(): Promise<void> {
  const since = argValue('--since') ?? '7 days ago';
  let config: AppConfig;
  try {
    config = loadConfig(nodePath.resolve('config.json'));
  } catch (err) {
    console.error(`config.json 无效:${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  console.error(`材料范围:${config.repos.map(r => r.name).join(', ')}`);

  const model = createGlmModel();
  // 模型名从 model.name 取而非直接读 env:GLM_MODEL 的 .env 解析发生在
  // createGlmModel 内部(惰性加载),提前读 process.env 会拿到未加载的值
  console.error(`周报 Agent 启动:model=${model.name} since="${since}"`);

  const result = await runWeeklyAgent({
    config,
    model,
    since,
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
    console.error(`草稿已保存:${result.draftPath}(共 ${result.rounds} 轮)`);
    console.error('下一步(人工 review,Agent 不代劳):');
    console.error('  1. npm run review     查看草稿与审计摘要');
    console.error('  2. npm run check-hash 校验草稿里的提交 hash 真实存在');
    console.error('  3. 认可后自行移入 reports/;不认可改到认可为止');
    process.exitCode = 0;
  } else {
    console.error(`运行未产出草稿(${result.status},${result.rounds} 轮):${result.errorMessage ?? '原因见审计日志'}`);
    console.error(`审计日志:${result.auditFile}`);
    process.exitCode = 1;
  }
}

// ---- review -----------------------------------------------------------------

async function reviewMode(): Promise<void> {
  const draftsDir = nodePath.resolve('drafts');
  const draft = latestFile(draftsDir, '.md');
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
        const what = calls.length > 0 ? calls.map(c => c.name).join(' + ') : '(纯文本,未调工具)';
        console.log(`  第 ${String(e['round'])} 轮${e['closing'] ? '(收尾)' : ''}: ${what}`);
      } else if (e['type'] === 'tool_result') {
        console.log(`    ↳ ${e['name']} → ${e['ok'] ? 'ok' : '失败(错误已回给模型)'}`);
      }
    }
  } else {
    console.log('(没有找到审计日志)');
  }

  console.log('='.repeat(60));
  console.log('人工核对清单:');
  console.log('  1. 草稿里每个 hash 是否真实:npm run check-hash');
  console.log('  2. 提交归类、学习增量是否符合你的实际工作');
  console.log('  3. 认可后自行移入 reports/;这是你的周报,不是 Agent 的');
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
