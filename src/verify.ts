// hash 防编造校验核心:抽取草稿里全部 7-8 位 hex 短 hash,对清单仓库的
// git log 全量比对。「AI 输出可信」不靠提示词,靠脚本比对。
//
// 7-8 位是 git 默认短 hash 长度;更短的误报高(普通单词撞 hex),更长的
// 模型很少完整输出。宁可漏检(模型编了个恰好存在的 hash)不可误伤——
// 漏检的概率是 16^7 分之一量级,误伤会把真实提交判成编造。

import { execFileSync } from 'node:child_process';
import type { AppConfig } from './types.js';

export interface HashCheck {
  /** 草稿中出现的去重后 hash 总数 */
  total: number;
  /** 能在清单仓库 git log 里找到的个数 */
  real: number;
  /** 找不到的(疑似编造) */
  bad: string[];
}

export function collectHashes(text: string): string[] {
  return [...new Set([...text.matchAll(/\b[0-9a-f]{7,8}\b/g)].map(m => m[0]).filter(Boolean))];
}

/** 各仓库近 perRepo 条提交的短 hash → 仓库名。仓库读不动就跳过(调用方决定要不要提示)。 */
export function knownHashes(config: AppConfig, perRepo = 1000, onRepoError?: (repo: string, err: unknown) => void): Map<string, string> {
  const known = new Map<string, string>();
  for (const repo of config.repos) {
    try {
      const out = execFileSync('git', ['-C', repo.path, 'log', '--pretty=%h', '-n', String(perRepo)], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      });
      for (const h of out.split('\n')) {
        const t = h.trim();
        if (t) known.set(t, repo.name);
      }
    } catch (err) {
      onRepoError?.(repo.name, err);
    }
  }
  return known;
}

export function verifyDraftHashes(text: string, known: Map<string, string>): HashCheck {
  const hashes = collectHashes(text);
  const bad = hashes.filter(h => !known.has(h));
  return { total: hashes.length, real: hashes.length - bad.length, bad };
}
