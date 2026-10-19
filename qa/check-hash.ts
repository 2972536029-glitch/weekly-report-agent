// hash 防编造校验 CLI:抽草稿里所有 7-8 位 hex 串,对 config.json 全部仓库
// 的 git log 全量比对(核心逻辑在 src/verify.ts,accept 的门禁复用同一份)。
//
// 用法:npm run check-hash            # 校验 drafts/ 最新草稿
//       npm run check-hash -- <file> # 校验指定草稿

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { knownHashes, verifyDraftHashes } from '../src/verify.js';
import type { AppConfig } from '../src/types.js';

const arg = process.argv[2];
let draftFile: string;
if (arg && !arg.startsWith('--')) {
  draftFile = resolve(arg);
} else {
  const drafts = readdirSync('drafts').filter(f => f.endsWith('.md'));
  if (drafts.length === 0) {
    console.error('drafts/ 里没有草稿');
    process.exit(1);
  }
  draftFile = join('drafts', drafts[drafts.length - 1]!);
}

const config = JSON.parse(readFileSync('config.json', 'utf8')) as AppConfig;
const text = readFileSync(draftFile, 'utf8');

const known = knownHashes(config, 1000, (repo, err) => {
  console.error(`⚠ ${repo} 的 git log 读取失败:${err instanceof Error ? err.message : err}`);
});
const check = verifyDraftHashes(text, known);

if (check.total === 0) {
  console.log('草稿里没有出现任何提交 hash(可能本周无提交,请人工确认是否合理)');
  process.exit(0);
}

console.log(`校验 ${draftFile} 中的 ${check.total} 个 hash:\n`);
for (const t of new Set([...text.matchAll(/\b[0-9a-f]{7,8}\b/g)].map(m => m[0]).filter(Boolean))) {
  const owner = known.get(t);
  if (owner) console.log(`  ✓ ${t} → ${owner}`);
}
for (const t of check.bad) {
  console.log(`  ✗ ${t} → 在任何清单仓库的 git log 里都找不到(疑似编造!)`);
}
console.log(`\n结果:${check.real}/${check.total} 个 hash 真实`);
process.exit(check.bad.length ? 1 : 0);
