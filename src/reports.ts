// reports/:用户已认可的周报终稿。accept 把「核对」自动化(hash 门禁)、
// 把「决定」留给人——命令由人敲,Agent 永不自推草稿(任务说明红线)。
//
// 门禁语义:
// - 有 hash 且全部真实 → 收录(移入 reports/ + 追加 index.md);
// - 存在疑似编造的 hash → 拒绝,草稿留在 drafts/ 等人修;
// - 零 hash(本周无提交的合法形态)→ 放行,由人自行确认合理性。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import * as nodePath from 'node:path';
import { knownHashes, verifyDraftHashes } from './verify.js';
import type { AppConfig } from './types.js';

export interface AcceptOutcome {
  ok: boolean;
  message: string;
  reportPath?: string;
}

export function acceptDraft(draftPath: string, config: AppConfig, reportsDir = nodePath.resolve('reports')): AcceptOutcome {
  if (!existsSync(draftPath)) {
    return { ok: false, message: `草稿不存在:${draftPath}` };
  }
  const text = readFileSync(draftPath, 'utf8');
  const check = verifyDraftHashes(text, knownHashes(config));
  if (check.bad.length > 0) {
    return { ok: false, message: `hash 校验未通过,拒绝收录:${check.bad.length} 个疑似编造(${check.bad.join(', ')})。请先修正草稿。` };
  }
  mkdirSync(reportsDir, { recursive: true });
  const name = nodePath.basename(draftPath);
  let dest = nodePath.join(reportsDir, name);
  let n = 2;
  while (existsSync(dest)) dest = nodePath.join(reportsDir, name.replace(/\.md$/, '') + `-${n++}.md`);
  renameSync(draftPath, dest);
  appendFileSync(
    nodePath.join(reportsDir, 'index.md'),
    `- ${nodePath.basename(dest)} — accepted ${new Date().toISOString().slice(0, 10)},hash ${check.real}/${check.total} 真实\n`,
    'utf8',
  );
  return {
    ok: true,
    message: `已收录:${dest}(hash ${check.real}/${check.total} 真实)`,
    reportPath: dest,
  };
}
