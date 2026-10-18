// 本地工具集:list_repos / git_log / read_file / save_draft。
//
// 安全面的设计:
// - 模型只能引用清单里的仓库名(name),永远接触不到绝对路径参数;
// - read_file 的路径做归一化 + 白名单前缀校验,防越界读(../ 与绝对路径都拦);
// - save_draft 没有 path 参数,目录钉死在代码里——模型想写别处都无从说起。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { RepoDef, ToolDef, ToolResult } from './types.js';

const execFileP = promisify(execFile);

const GIT_LOG_LIMIT = 100;
export const READ_FILE_MAX = 4000;

export interface ToolContext {
  repos: RepoDef[];
  /** drafts 目录(默认 <项目根>/drafts,E2E 注入临时目录) */
  draftsDir: string;
}

export function buildTools(ctx: ToolContext): ToolDef[] {
  return [listRepos(ctx), gitLog(ctx), readFile(ctx), saveDraft(ctx)];
}

// ---- list_repos -------------------------------------------------------------

function listRepos(ctx: ToolContext): ToolDef {
  return {
    name: 'list_repos',
    description: '列出可用的本地仓库清单(名称、路径、说明)。写周报前先调它了解材料范围。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const lines = ctx.repos.map(r => `- ${r.name}(${r.path}):${r.desc}`);
      return { ok: true, data: `共 ${ctx.repos.length} 个仓库:\n${lines.join('\n')}` };
    },
  };
}

// ---- git_log ----------------------------------------------------------------

function gitLog(ctx: ToolContext): ToolDef {
  return {
    name: 'git_log',
    description: `读取某个仓库自指定时间以来的提交记录(每行:hash<TAB>日期<TAB>标题),最多 ${GIT_LOG_LIMIT} 条。repo 必须是 list_repos 返回的仓库名;since 用 git 能理解的表达,如 "7 days ago" 或 "2026-10-12"。`,
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓库名(list_repos 返回的名称)' },
        since: { type: 'string', description: '起始时间,如 "7 days ago"' },
      },
      required: ['repo', 'since'],
      additionalProperties: false,
    },
    async execute(args) {
      const repo = typeof args['repo'] === 'string' ? args['repo'] : '';
      const since = typeof args['since'] === 'string' ? args['since'].trim() : '';
      const def = ctx.repos.find(r => r.name === repo);
      if (!def) {
        return { ok: false, error: `仓库 "${repo}" 不在清单中`, hint: '先调 list_repos 查看可用仓库名' };
      }
      if (!since || since.startsWith('-')) {
        return { ok: false, error: 'since 不能为空,且不能以 "-" 开头', hint: '如 "7 days ago" 或 "2026-10-12"' };
      }
      try {
        // 取 limit+1 条:第 101 行出现即证明发生了截断,返回前 100 条并注明
        const { stdout } = await execFileP('git', [
          '-C', def.path,
          '-c', 'core.quotepath=false',
          'log', `--since=${since}`, `--max-count=${GIT_LOG_LIMIT + 1}`,
          '--date=short', '--pretty=format:%h%x09%ad%x09%s',
        ], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
        const all = stdout.split('\n').filter(l => l.trim().length > 0);
        if (all.length === 0) {
          return { ok: true, data: `${repo}:自 ${since} 以来无提交` };
        }
        const truncated = all.length > GIT_LOG_LIMIT;
        const lines = truncated ? all.slice(0, GIT_LOG_LIMIT) : all;
        const note = truncated ? `\n(已达 ${GIT_LOG_LIMIT} 条上限,已截断;完整列表请自行缩小 since 范围)` : '';
        return { ok: true, data: `${repo} 自 ${since} 以来 ${all.length} 条提交:\n${lines.join('\n')}${note}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `git_log(${repo}) 失败:${msg.slice(0, 300)}`, hint: '该路径可能不是 git 仓库;可跳过此仓库继续' };
      }
    },
  };
}

// ---- read_file --------------------------------------------------------------

/**
 * 路径解析:优先把「仓库名/相对路径」拼成真实路径——这是模型最自然的
 * 表达(list_repos 暴露的就是仓库名);拼不上再当普通路径 resolve。
 * 无论走哪条路,结果都要过下面的白名单校验,这里不放宽任何边界。
 */
function resolveRepoPath(raw: string, repos: RepoDef[]): string {
  const norm = raw.replace(/\\/g, '/');
  const slash = norm.indexOf('/');
  if (slash > 0) {
    const head = norm.slice(0, slash);
    const def = repos.find(r => r.name === head);
    if (def) return nodePath.join(def.path, norm.slice(slash + 1));
  }
  return nodePath.resolve(raw);
}

function readFile(ctx: ToolContext): ToolDef {
  return {
    name: 'read_file',
    description: `读取清单仓库内的文本文件(单次最多 ${READ_FILE_MAX} 字符,超出会截断并在结果里注明总字符数)。路径支持两种写法:仓库内相对路径(如 game-ai-journey/learning-progress.md),或绝对路径。追加型文件(日志/台账)的最新内容在文件末尾:第一次读取若被截断,用返回的总字符数计算 offset 再读尾部。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径,如 "game-ai-journey/learning-progress.md"' },
        offset: { type: 'number', description: '起始字符偏移,默认 0(文件开头)' },
        max: { type: 'number', description: `读取的字符数上限,默认 ${READ_FILE_MAX}` },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(args) {
      const raw = typeof args['path'] === 'string' ? args['path'] : '';
      const maxArg = typeof args['max'] === 'number' ? args['max'] : READ_FILE_MAX;
      const offsetArg = typeof args['offset'] === 'number' ? args['offset'] : 0;
      if (!raw) return { ok: false, error: 'path 不能为空' };
      const resolved = resolveRepoPath(raw, ctx.repos);
      const root = ctx.repos
        .map(r => nodePath.resolve(r.path))
        .find(rp => resolved === rp || resolved.startsWith(rp + nodePath.sep));
      if (!root) {
        return { ok: false, error: `路径越界:${raw} 不在任何清单仓库内`, hint: 'read_file 只允许读清单仓库内的文件;调 list_repos 查看范围' };
      }
      if (!existsSync(resolved)) {
        return { ok: false, error: `文件不存在:${resolved}`, hint: '确认文件名(如 learning-progress.md 在仓库根)' };
      }
      let content: string;
      try {
        content = readFileSync(resolved, 'utf8');
      } catch (err) {
        return { ok: false, error: `读取失败:${err instanceof Error ? err.message : err}`, hint: '可能是二进制文件或权限不足,可跳过' };
      }
      const max = Math.min(Math.max(1, Math.floor(maxArg) || READ_FILE_MAX), READ_FILE_MAX);
      const chars = Array.from(content); // 按码点切,避免把 emoji/生僻字切成坏代理对
      const offset = Math.max(0, Math.min(Math.floor(offsetArg) || 0, chars.length));
      const window = chars.slice(offset, offset + max);
      if (window.length === 0) {
        return { ok: true, data: `(offset=${offset} 已超出文件末尾;文件共 ${chars.length} 字符)` };
      }
      const range = `(读取 ${offset}–${offset + window.length} 字符 / 共 ${chars.length} 字符)`;
      if (offset + window.length < chars.length) {
        return { ok: true, data: `${range}\n${window.join('')}\n(已截断:用 offset=${offset + window.length} 继续读)` };
      }
      return { ok: true, data: `${range}\n${window.join('')}` };
    },
  };
}

// ---- save_draft -------------------------------------------------------------

/** ISO 8601 周号(周一为一周之始;含 1 月 4 日的那周是第 1 周) */
export function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

function slugify(title: string): string {
  const slug = title
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'weekly';
}

function saveDraft(ctx: ToolContext): ToolDef {
  return {
    name: 'save_draft',
    description: '保存周报草稿(自动写入 drafts/ 目录,文件名自动按 ISO 周号生成)。收集完材料后必须调用它收尾;草稿只停在 drafts/ 等用户 review,不会自动提交。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '草稿标题(用于生成文件名)' },
        md: { type: 'string', description: '草稿全文(markdown)' },
      },
      required: ['title', 'md'],
      additionalProperties: false,
    },
    async execute(args) {
      const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
      const md = typeof args['md'] === 'string' ? args['md'] : '';
      if (!title) return { ok: false, error: 'title 不能为空' };
      if (md.trim().length < 50) {
        return { ok: false, error: `草稿正文过短(${md.length} 字符),不像一份周报`, hint: '请写完整结构后再保存' };
      }
      const { year, week } = isoWeek(new Date());
      const base = `${year}-W${String(week).padStart(2, '0')}-${slugify(title)}`;
      mkdirSync(ctx.draftsDir, { recursive: true });
      // 同名避让:重跑不覆盖用户还没看完的上一版
      let full = nodePath.join(ctx.draftsDir, `${base}.md`);
      let n = 2;
      while (existsSync(full)) full = nodePath.join(ctx.draftsDir, `${base}-${n++}.md`);
      writeFileSync(full, md.endsWith('\n') ? md : `${md}\n`, 'utf8');
      return {
        ok: true,
        data: `草稿已保存:${full}(等用户 review;用户认可后自行移入 reports/,Agent 不代劳)`,
        draftPath: full,
      };
    },
  };
}
