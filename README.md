# weekly-report-agent · 周报 Agent

给定仓库清单和时间段,**自主规划**调用本地工具(读 git log、读文件、写草稿),产出一篇周报 markdown 草稿——然后**停在用户面前等 review,绝不自动提交任何东西**。

华为「AI Agent 技术与应用」微认证的配套实操项目,补的是另一半能力:不是"用户点一下它调一次工具"(单轮 Function Calling,见 [pokemon-dex-ai]),而是**给一个目标,Agent 自己决定先做什么、后做什么、做几步**。

[pokemon-dex-ai]: https://github.com/2972536029-glitch/pokemon-dex-ai

## 快速开始

```bash
npm install
cp .env.example .env        # 填 GLM_API_KEY(智谱开放平台)
```

| 命令 | 作用 |
|---|---|
| `npm run weekly -- --since "7 days ago"` | 生成周报草稿 → `drafts/`(`--max-rounds N` 可调轮次上限 1-20) |
| `npm run review` | 打印最新草稿 + 审计摘要(逐轮决策 + token 累计)+ 人工核对清单 |
| `npm run check-hash` | 校验草稿里每个提交 hash 真实存在(防编造) |
| `npm run accept -- [draft.md]` | **hash 门禁通过后**把草稿收录进 `reports/` 并登记 index.md |
| `npm run history` | 历史运行(轮次/状态/token)+ 草稿与收录状态一览 |
| `npm run e2e` | 65 项断言,fake 模型 + fixture 仓库,零成本 |
| `npm run typecheck` | `tsc --noEmit` |

仓库清单与周报 rubric 在 `config.json`;token 预算可用环境变量 `WRA_TOKEN_BUDGET` 调整(默认 60000)。

## 工作流(人在回路)

```
weekly(生成草稿)→ review(人读,对照审计可回放)→ check-hash(机器核事实)
      → 人判断:不认可 → 改到认可为止
                 认可   → accept(机器再核一遍 hash,过门禁才收录)→ reports/
```

「核对」逐步自动化,「决定」始终在人:weekly 循环里的 Agent 永远不会自推草稿;accept 是人敲的命令,门禁只是替人把最后一道事实关。

## 架构

```
config.json   仓库清单 + 周报 rubric 提示
src/agent.ts  Agent 循环:目标 → 模型决定调哪个工具 → 执行 → 结果回填 → 再决定 …
              (轮次上限 8 + token 预算 60k,双上限;触顶带材料强制收尾;
               收尾模式工具白名单:只允许 save_draft)
src/tools.ts  list_repos / git_log(含变更量统计)/ read_file(路径白名单+offset 尾读)/ save_draft
src/llm.ts    GLM chat(tool calling;指数退避+抖动重试;usage 真值回传;fake 可注入)
src/audit.ts  审计日志(JSONL:每轮模型说了什么、调了什么、返回了什么、token 多少)
src/verify.ts hash 防编造核心(check-hash 与 accept 门禁共用)
src/reports.ts accept:hash 门禁 → 移入 reports/ → 登记 index.md
drafts/       草稿(gitignore);reports/ 已收录终稿 + index.md;audit/ 审计日志(入库,可回放)
```

## 设计决策(面试防守要点)

| 决策 | 理由 |
|---|---|
| 轮次上限 8,触顶进入"用现有材料收尾"模式 | 没上限 = 失控螺旋(反复查同一仓库、无限展开);8 给足"4 仓 × 收集+核实"的规划空间又不至于失控。触顶不许静默截断——带已有材料强制走 save_draft,材料缺口如实写进「未竟事项」。降级必须带 reason,不然草稿撒谎 |
| token 预算是运行级、事后计量 + 轮前闸 | 事后计量(GLM usage 真值优先,缺失字符/2 估算兜底)+ 每轮发起前检查:超限不报错、不终止,强制转收尾——熔断是降级不是错误。预算保护的是成本,草稿还是要交 |
| 收尾模式工具白名单(prompt + 代码双保险) | system prompt 说"不要再收集"是君子协定;代码层面直接拒收 save_draft 之外的调用,拒绝原因回给模型让它纠正。守卫是边界,回填是教育 |
| 工具失败作为观察结果回给模型,不 fail-fast | 一个仓库坏了不该赔上整篇周报。错误回填后模型自己决定跳过还是换路——这正是"自主规划"和"死流水线"的分水岭:死流水线遇到异常只能整体崩,Agent 能绕 |
| 草稿不自动提交,accept 的门禁只核事实不做判断 | 产品行为与工程人设同构:AI 生成 + 人工逐行 review。Agent 代提交等于替用户签字;accept 把 hash 核对自动化,收录与否仍由人敲命令决定 |
| 执行顺序不写死,由模型按 rubric 自主规划 | "先 git_log 再总结"的硬编码流水线不是 Agent,面试会被戳穿。代码只守边界(轮次、预算、白名单、审计),规划交给模型 |
| E2E 用注入的 fake 模型,真模型只验收跑 | 可断言(fake 决策序列 → 确定性结果)+ 零成本 + CI 可跑。测试路径与生产是同一套循环代码,不是旁路——mock 与生产行为同构 |
| 审计日志 JSONL、每轮全量追加 | append-only 写崩不损已有行;"决策可回放"是 Agent 可信度的证据,history 命令也从它现算——append-only 日志即唯一事实源,不另维护状态文件(两份状态迟早不一致) |
| read_file 白名单 = 路径归一化 + 前缀校验 | `..` 和绝对路径在 resolve 后统一归一,再校验是否落在清单仓库内;支持「仓库名/相对路径」拼法(解析后仍过校验,不放宽边界);单次 4000 字符 + offset 续读防灌爆上下文 |
| git_log 取 limit+1 条判断截断;附聚合 shortstat | 第 101 行存在即证明截断发生,一次调用同时拿到"前 100 条"和"截断事实";聚合变更量(文件数/增删行)给模型可引用的真实数字,统计失败降级省略不报错 |
| accept 门禁放行"零 hash"草稿 | 本周真的无提交是合法形态,hash 数为 0 不是编造信号;宁可漏检不可误伤(编出恰好存在的 hash 概率是 16^7 分之一量级) |
| 零运行时依赖 | node:http/fetch/execFile 够用;供应链面小,chat 客户端 ~100 行,每一行都可解释 |

## 已知取舍

- `git_log` 的 since 直接传给 git,模型给错(如未来时间)会得到"无提交"——这是真实结果而非错误,如实回给模型
- token 预算默认 60k,只做量级护栏不做计费账单;只显示 token 数不折算金额——不假装精确
- 同名草稿/同名终稿自动 `-2` 避让,不覆盖还没 review 的版本
- Windows 下 `git -c core.quotepath=false` 防中文路径转义;子进程数组传参,无 shell 注入面
- read_file 按 JS 字符截断前先按码点切,避免把 emoji/生僻字切成坏代理对

## Roadmap(未做,列出来是为了说清为什么现在不做)

- `--repos` 子集过滤:临时需求改 config.json 即可,单做参数面不值得
- 草稿质量评分(结构断言 + LLM-as-judge):依赖高频使用收集坏例,先攒
- 多模型/多 provider:单一 GLM 够用,抽象层等第二个真实需求出现再建

## 协作红线

- 四个源仓库(见 config.json)**只读**:只许 git log / read_file,不许写、不许 commit、不许切分支;
- `GLM_API_KEY` 不回显、不入库、不进审计日志;
- 每次运行的完整决策链在 `audit/run-*.jsonl`,`npm run history` 一览,review 草稿时随手可查。
