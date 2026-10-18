// hash 防编造校验:抽草稿里所有 7-8 位 hex 串,对 config.json 全部仓库的
// git log 全量比对。真模型验收用(M1 验收标准:草稿里每个提交 hash 都必须
// 能在 git log 里找到)。
//
// 用法:npm run check-hash            # 校验 drafts/ 最新草稿
//       node qa/check-hash.mjs <file> # 校验指定草稿

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const arg = process.argv[2];
let draftFile;
if (arg) {
  draftFile = resolve(arg);
} else {
  const drafts = readdirSync('drafts').filter(f => f.endsWith('.md'));
  if (drafts.length === 0) {
    console.error('drafts/ 里没有草稿');
    process.exit(1);
  }
  draftFile = join('drafts', drafts[drafts.length - 1]);
}

const config = JSON.parse(readFileSync('config.json', 'utf8'));
const text = readFileSync(draftFile, 'utf8');

// 收集所有仓库的短 hash 全集(近 1000 条足够周报场景)
const known = new Map(); // hash -> repo
for (const repo of config.repos) {
  try {
    const out = execFileSync('git', ['-C', repo.path, 'log', '--pretty=%h', '-n', '1000'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    for (const h of out.split('\n')) {
      if (h.trim()) known.set(h.trim(), repo.name);
    }
  } catch (err) {
    console.error(`⚠ ${repo.name} 的 git log 读取失败:${err.message}`);
  }
}

const tokens = [...text.matchAll(/\b[0-9a-f]{7,8}\b/g)].map(m => m[0]);
if (tokens.length === 0) {
  console.log('草稿里没有出现任何提交 hash(可能本周无提交,请人工确认是否合理)');
  process.exit(0);
}

let bad = 0;
const seen = new Set();
console.log(`校验 ${draftFile} 中的 ${tokens.length} 个 hash:\n`);
for (const t of tokens) {
  if (seen.has(t)) continue;
  seen.add(t);
  const owner = known.get(t);
  if (owner) {
    console.log(`  ✓ ${t} → ${owner}`);
  } else {
    bad++;
    console.log(`  ✗ ${t} → 在任何清单仓库的 git log 里都找不到(疑似编造!)`);
  }
}
console.log(`\n结果:${seen.size - bad}/${seen.size} 个 hash 真实`);
process.exit(bad ? 1 : 0);
