// E2E:全程 fake 模型 + fixture 临时仓库,一分钱不烧。
// 用 tsx 跑(npm run e2e)以便 import src/*.ts。
//
// 覆盖:git_log 解析(含中文)/ 空结果 / 未知仓;read_file 越界与截断;
// save_draft 文件名、同名避让、过短拒绝;agent 全流程(fake 决策序列);
// 工具错误回给模型;轮次上限收尾;纯文本不保存退出;收尾也失败。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools, isoWeek, READ_FILE_MAX } from '../src/tools.ts';
import { runWeeklyAgent } from '../src/agent.ts';

let pass = 0, fail = 0;
const assert = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}  ${extra}`); }
};

// ---- fixture:临时 git 仓(确定内容的提交) --------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'wra-e2e-'));
const fixtureRepo = join(tmp, 'fixture-repo');
const badRepo = join(tmp, 'not-a-repo');
mkdirSync(fixtureRepo, { recursive: true });
mkdirSync(badRepo, { recursive: true });
mkdirSync(join(tmp, 'drafts'), { recursive: true });
mkdirSync(join(tmp, 'audit'), { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: fixtureRepo, encoding: 'utf8' });
git('init', '-b', 'main');
git('config', 'user.name', 'e2e');
git('config', 'user.email', 'e2e@test.local');
const hashes = [];
const commits = [
  ['a.md', 'feat: 初始提交 功能说明'],
  ['b.md', 'fix: 修复空指针 bug'],
  ['docs/笔记.md', 'docs: 周报素材 中文文档标题'],
];
for (const [file, msg] of commits) {
  const full = join(fixtureRepo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `内容 ${file}\n`, 'utf8');
  git('add', '.');
  git('commit', '-m', msg);
  hashes.push(execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: fixtureRepo, encoding: 'utf8' }).trim());
}
const longContent = '甲乙丙丁'.repeat(2000); // 8000 字符,供截断测试
writeFileSync(join(fixtureRepo, 'long.md'), longContent, 'utf8');

const testConfig = {
  repos: [
    { name: 'fixture', path: fixtureRepo, desc: '测试用仓库' },
    { name: 'badrepo', path: badRepo, desc: '非 git 目录,用于测试错误回填' },
  ],
  rubric: '草稿必须包含「材料来源清单」和「本周提交」两节。',
};
const toolCtx = { repos: testConfig.repos, draftsDir: join(tmp, 'drafts') };
const tools = buildTools(toolCtx);
const tool = name => tools.find(t => t.name === name);

// ---- 1. git_log:解析、中文、hash -------------------------------------------
{
  const r = await tool('git_log').execute({ repo: 'fixture', since: '1 day ago' });
  assert(r.ok === true && typeof r.data === 'string', 'git_log 正常返回', JSON.stringify(r).slice(0, 200));
  assert(r.data.includes('自 1 day ago 以来 3 条提交'), 'git_log 条数正确', r.data.slice(0, 100));
  assert(hashes.every(h => r.data.includes(h)), 'git_log 含全部真实 hash', r.data.slice(0, 300));
  assert(r.data.includes('初始提交 功能说明'), 'git_log 中文标题不乱码', r.data.slice(0, 300));
  const lines = r.data.split('\n').filter(l => /^[0-9a-f]{7}\t/.test(l));
  assert(lines.length === 3 && lines.every(l => /^[0-9a-f]{7}\t\d{4}-\d{2}-\d{2}\t/.test(l)), 'git_log 行格式 hash<TAB>日期<TAB>标题');
}
{
  const r = await tool('git_log').execute({ repo: 'fixture', since: '2050-01-01' });
  assert(r.ok === true && r.data.includes('无提交'), 'git_log 空结果返回"无提交"而非报错', JSON.stringify(r));
}
{
  const r = await tool('git_log').execute({ repo: 'nope', since: '1 day ago' });
  assert(r.ok === false && r.data === undefined && typeof r.error === 'string', 'git_log 未知仓库名返回 ok:false', JSON.stringify(r));
  assert((r.error ?? '').includes('不在清单'), '未知仓错误信息可读');
}
{
  const r = await tool('git_log').execute({ repo: 'badrepo', since: '1 day ago' });
  assert(r.ok === false && typeof r.error === 'string', 'git_log 非 git 目录返回错误而非抛异常', JSON.stringify(r).slice(0, 150));
}

// ---- 2. read_file:越界、截断、正常 -----------------------------------------
{
  const r = await tool('read_file').execute({ path: 'C:\\Windows\\win.ini' });
  assert(r.ok === false && (r.error ?? '').includes('越界'), 'read_file 清单外绝对路径被拒', JSON.stringify(r).slice(0, 150));
  const r2 = await tool('read_file').execute({ path: join(tmp, 'outside.txt') });
  assert(r2.ok === false && (r2.error ?? '').includes('越界'), 'read_file 清单外临时路径被拒');
  const r3 = await tool('read_file').execute({ path: join(fixtureRepo, '..', 'fixture-repo', 'a.md') });
  assert(r3.ok === true && r3.data.includes('内容 a.md'), 'read_file 归一化后清单内相对路径可读(内容含中文)');
  const r6 = await tool('read_file').execute({ path: 'fixture/docs/笔记.md' });
  assert(r6.ok === true && r6.data.includes('内容'), 'read_file 支持「仓库名/相对路径」拼法(模型最自然的表达)');
  const r7 = await tool('read_file').execute({ path: 'nope/../fixture/a.md' });
  assert(r7.ok === false && (r7.error ?? '').includes('越界'), 'read_file 仓库名拼法遇到未知仓库名仍被拒');
  const r4 = await tool('read_file').execute({ path: join(fixtureRepo, 'long.md'), max: 5 });
  assert(r4.ok === true && r4.data.includes('甲乙丙丁甲') && (r4.data ?? '').includes('已截断'), 'read_file 按字符截断并注明');
  assert(Array.from(r4.data.split('\n')[1]).length === 5, '截断长度恰为 max=5 字符');
  const r5 = await tool('read_file').execute({ path: join(fixtureRepo, 'long.md') });
  assert(r5.ok === true && r5.data.includes('读取 0–4000 字符 / 共 8000 字符') && r5.data.includes('offset=4000'), 'read_file 默认上限 4000 字符并给出续读偏移');
  const r8 = await tool('read_file').execute({ path: join(fixtureRepo, 'long.md'), offset: 4000 });
  assert(r8.ok === true && r8.data.includes('读取 4000–8000 字符 / 共 8000 字符') && !r8.data.includes('已截断'), 'read_file offset 读尾部一次拿完,不再截断');
  const r9 = await tool('read_file').execute({ path: join(fixtureRepo, 'long.md'), offset: 99999 });
  assert(r9.ok === true && r9.data.includes('超出文件末尾'), 'read_file offset 越界有明确提示而非报错');
}

// ---- 3. save_draft:文件名、避让、过短拒绝 ----------------------------------
{
  const { year, week } = isoWeek(new Date());
  const ww = String(week).padStart(2, '0');
  const r = await tool('save_draft').execute({ title: '周报 v1', md: '# 周报\n\n' + '内容'.repeat(30) });
  assert(r.ok === true && typeof r.draftPath === 'string', 'save_draft 成功返回 draftPath', JSON.stringify(r).slice(0, 150));
  assert(new RegExp(`${year}-W${ww}-周报-v1\\.md$`).test(r.draftPath), `save_draft 文件名按 ISO 周号(期望 ${year}-W${ww})`, r.draftPath);
  assert(r.draftPath.startsWith(join(tmp, 'drafts')), '草稿落在注入的 drafts 目录');
  const r2 = await tool('save_draft').execute({ title: '周报 v1', md: '# 周报\n\n' + '内容'.repeat(30) });
  assert(r2.ok === true && /-2\.md$/.test(r2.draftPath), '同名草稿避让为 -2 后缀,不覆盖上一版', r2.draftPath);
  const r3 = await tool('save_draft').execute({ title: '周报 v1', md: '太短' });
  assert(r3.ok === false, 'save_draft 过短正文被拒');
  const r4 = await tool('save_draft').execute({ title: 'a/b:c*d?.md', md: '# 周报\n\n' + '内容'.repeat(30) });
  assert(r4.ok === true && !/[\\/:*?"<>|]/.test(r4.draftPath.split(/[\\/]/).pop().replace(/\.md$/, '').slice(10)), 'slug 清洗掉文件名非法字符', r4.draftPath);
}

// ---- fake 模型 ---------------------------------------------------------------
// steps:每步 {text, toolCalls} 或 (messages) => step。chat 记录收到的 messages 供断言。
function fakeModel(steps) {
  let i = 0;
  const received = [];
  return {
    name: 'fake-scripted',
    received,
    async chat(messages) {
      received.push(messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : null,
        hasToolCalls: Array.isArray(m.tool_calls),
      })));
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      return typeof step === 'function' ? step(messages) : step;
    },
  };
}
const call = (name, args) => ({ id: `call_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args) } });
const auditLines = dir => readFileSync(dir, 'utf8').trim().split('\n').map(l => JSON.parse(l));

// ---- 4. agent 全流程(fake 决策序列) ---------------------------------------
{
  const md = `# 周报\n\n## 材料来源清单\n- fixture:git log(1 day ago)\n\n## 本周提交\n- fixture: ${hashes[0]} 初始提交 功能说明\n`;
  const model = fakeModel([
    { text: '', toolCalls: [call('list_repos', {})] },
    { text: '', toolCalls: [call('git_log', { repo: 'fixture', since: '1 day ago' })] },
    { text: '', toolCalls: [call('save_draft', { title: 'E2E 周报', md })] },
    { text: '草稿已保存,请 review。', toolCalls: [] },
  ]);
  const result = await runWeeklyAgent({
    config: testConfig, model, since: '1 day ago', maxRounds: 8,
    paths: { draftsDir: join(tmp, 'drafts'), auditDir: join(tmp, 'audit') },
  });
  assert(result.status === 'draft_saved' && result.draftPath, 'agent 全流程产出草稿', JSON.stringify(result).slice(0, 200));
  assert(result.draftPath.includes('E2E-周报'), '草稿文件名含清洗后的标题', result.draftPath);
  const saved = readFileSync(result.draftPath, 'utf8');
  assert(saved.includes(hashes[0]) && saved.includes('材料来源清单'), '草稿内容含真实 hash 与来源清单');
  assert(result.rounds === 3, 'save_draft 成功当轮即结束,不多烧一轮', `got ${result.rounds}`);
  // fake 模型收到的事实回填:第 2 轮的 tool 消息应含 list_repos 的仓库清单
  const secondRound = model.received[1];
  assert(secondRound.some(m => m.role === 'tool' && (m.content ?? '').includes('fixture')), '工具结果回填进对话');
}

// 审计日志文件已生成(run_start/model_round/tool_result/run_end 的完整性在用例 6 断言)
{
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(join(tmp, 'audit')).filter(f => f.endsWith('.jsonl'));
  assert(files.length >= 1, '审计日志文件已生成', files.join(','));
}

// ---- 5. 工具错误回给模型(不是抛异常打断循环) -------------------------------
{
  const md = '# 周报\n\n' + '内容'.repeat(30);
  const model = fakeModel([
    { text: '', toolCalls: [call('git_log', { repo: 'does-not-exist', since: '1 day ago' })] },
    { text: '清单里没有这个仓库,我用 fixture 代替。', toolCalls: [call('save_draft', { title: '错误回填测试', md })] },
    { text: 'done', toolCalls: [] },
  ]);
  const result = await runWeeklyAgent({
    config: testConfig, model, since: '1 day ago', maxRounds: 8,
    paths: { draftsDir: join(tmp, 'drafts'), auditDir: join(tmp, 'audit') },
  });
  assert(result.status === 'draft_saved', '工具报错后 agent 仍正常收尾', JSON.stringify(result).slice(0, 200));
  const secondRound = model.received[1];
  const toolMsg = secondRound.find(m => m.role === 'tool');
  assert(toolMsg && (toolMsg.content ?? '').includes('不在清单'), '错误信息作为 tool 结果回给模型', JSON.stringify(toolMsg).slice(0, 200));
  // 审计里也如实记了失败
  const { readdirSync: rd } = await import('node:fs');
  const newest = rd(join(tmp, 'audit')).filter(f => f.endsWith('.jsonl')).sort().pop();
  const lines = auditLines(join(tmp, 'audit', newest));
  assert(lines.some(l => l.type === 'tool_result' && l.ok === false && l.name === 'git_log'), '审计日志如实记录失败的工具调用');
}

// ---- 6. 轮次上限触发收尾(fake 死循环调工具,收到收尾指令后才保存) ---------
{
  let sawClosing = false;
  const md = '# 周报(触顶收尾)\n\n' + '内容'.repeat(30);
  const model = fakeModel([
    () => ({ text: '', toolCalls: [call('git_log', { repo: 'fixture', since: '1 day ago' })] }),
    (messages) => {
      const closing = messages.some(m => m.role === 'user' && (m.content ?? '').includes('轮次已达上限'));
      if (closing) { sawClosing = true; return { text: '', toolCalls: [call('save_draft', { title: '触顶收尾', md })] }; }
      return { text: '', toolCalls: [call('git_log', { repo: 'fixture', since: '1 day ago' })] };
    },
  ]);
  const result = await runWeeklyAgent({
    config: testConfig, model, since: '1 day ago', maxRounds: 3,
    paths: { draftsDir: join(tmp, 'drafts'), auditDir: join(tmp, 'audit') },
  });
  assert(sawClosing, '触顶后收到「轮次已达上限」收尾指令');
  assert(result.status === 'draft_saved', '轮次上限触发时仍正常收尾保存', JSON.stringify(result).slice(0, 200));
  assert(result.rounds > 3, `收尾轮计入轮数(主循环 3 轮 + 收尾,共 ${result.rounds})`);
  const auditDir = join(tmp, 'audit');
  const { readdirSync } = await import('node:fs');
  const newest = readdirSync(auditDir).filter(f => f.endsWith('.jsonl')).sort().pop();
  const lines = auditLines(join(auditDir, newest));
  assert(lines.some(l => l.type === 'model_round' && l.closing === true), '审计日志记录了收尾轮');
  assert(lines.some(l => l.type === 'run_end' && l.status === 'draft_saved'), '审计日志记录 run_end');
}

// ---- 7. 纯文本不保存:连续两轮退出,不给机会空转 -----------------------------
{
  const model = fakeModel([{ text: '我想想……', toolCalls: [] }]);
  const result = await runWeeklyAgent({
    config: testConfig, model, since: '1 day ago', maxRounds: 8,
    paths: { draftsDir: join(tmp, 'drafts'), auditDir: join(tmp, 'audit') },
  });
  assert(result.status === 'no_draft' && result.rounds === 2, '连续两轮纯文本即退出 no_draft', JSON.stringify(result).slice(0, 150));
  assert((result.errorMessage ?? '').length > 0, 'no_draft 带原因(不静默)');
}

// ---- 8. 触顶且收尾也失败:如实报 no_draft -----------------------------------
{
  const model = fakeModel([
    () => ({ text: '', toolCalls: [call('git_log', { repo: 'fixture', since: '1 day ago' })] }),
  ]);
  const result = await runWeeklyAgent({
    config: testConfig, model, since: '1 day ago', maxRounds: 2,
    paths: { draftsDir: join(tmp, 'drafts'), auditDir: join(tmp, 'audit') },
  });
  assert(result.status === 'no_draft' && result.rounds === 4, `主循环 2 轮 + 收尾 2 轮后如实报 no_draft(实际 ${result.rounds})`, JSON.stringify(result).slice(0, 150));
}

// ---- 清理 --------------------------------------------------------------------
rmSync(tmp, { recursive: true, force: true });
console.log(`\nE2E: ${pass} 通过, ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
