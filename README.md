# weekly-report-agent · 周报 Agent

给定仓库清单和时间段,**自主规划**调用本地工具(读 git log、读文件、写草稿),产出一篇周报 markdown 草稿——然后**停在用户面前等 review,绝不自动提交任何东西**。

华为「AI Agent 技术与应用」微认证的配套实操项目,补的是另一半能力:不是"用户点一下它调一次工具"(单轮 Function Calling,见 [pokemon-dex-ai]),而是**给一个目标,Agent 自己决定先做什么、后做什么、做几步**。

[pokemon-dex-ai]: https://github.com/2972536029-glitch/pokemon-dex-ai

## 快速开始

```bash
npm install
cp .env.example .env        # 填 GLM_API_KEY(智谱开放平台)
npm run weekly -- --since "7 days ago"   # 生成周报草稿 → drafts/
npm run review               # 打印最新草稿 + 审计摘要 + 人工核对清单
npm run check-hash           # 校验草稿里每个提交 hash 真实存在(防编造)
npm run e2e                  # 38 项断言,fake 模型 + fixture 仓库,零成本
npm run typecheck            # tsc --noEmit
```

仓库清单在 `config.json`(含周报 rubric)。草稿落 `drafts/`;**用户认可后自行移入 `reports/`,Agent 不代劳**——这一步是设计,不是省事。

## 架构

```
config.json   仓库清单 + 周报 rubric 提示
src/agent.ts  Agent 循环:目标 → 模型决定调哪个工具 → 执行 → 结果回填 → 再决定 …
              (轮次上限 8,触顶带材料收尾;每轮全量记录审计日志)
src/tools.ts  list_repos / git_log / read_file / save_draft(路径白名单)
src/llm.ts    GLM chat(tool calling;指数退避+抖动重试;fake 模型可注入)
src/audit.ts  审计日志(JSONL:每轮模型说了什么、调了什么、返回了什么)
drafts/       草稿(gitignore,等 review);audit/ 审计日志(入库,可回放)
```

## 设计决策(面试防守要点)

| 决策 | 理由 |
|---|---|
| 轮次上限 8,触顶进入"用现有材料收尾"模式 | 没上限 = 失控螺旋(反复查同一仓库、无限展开);8 给足"4 仓 × 收集+核实"的规划空间又不至于烧钱失控。触顶不许静默截断——带已有材料强制走 save_draft,材料缺口如实写进「未竟事项」。降级必须带 reason,不然草稿撒谎 |
| 工具失败作为观察结果回给模型,不 fail-fast | 一个仓库坏了不该赔上整篇周报。错误回填后模型自己决定跳过还是换路——这正是"自主规划"和"死流水线"的分水岭:死流水线遇到异常只能整体崩,Agent 能绕 |
| 草稿不自动提交,停在 drafts/ 等 review | 产品行为与工程人设同构:AI 生成 + 人工逐行 review。Agent 代提交等于替用户签字;`save_draft` 连 path 参数都没有,目录钉死在代码里,想写别处都无从说起 |
| 执行顺序不写死,由模型按 rubric 自主规划 | "先 git_log 再总结"的硬编码流水线不是 Agent,面试会被戳穿。代码只守边界(轮次、白名单、审计),规划交给模型 |
| E2E 用注入的 fake 模型,真模型只验收跑 | 可断言(fake 决策序列 → 确定性结果)+ 零成本 + CI 可跑。测试路径与生产是同一套循环代码,不是旁路——mock 与生产行为同构 |
| 审计日志 JSONL、每轮全量追加 | append-only 写崩不损已有行;"决策可回放"是 Agent 可信度的证据,也是 debug 的第一现场 |
| read_file 白名单 = 路径归一化 + 前缀校验 | `..` 和绝对路径在 resolve 后统一归一,再校验是否落在清单仓库内;单次 4000 字符防一次性灌爆上下文 |
| git_log 取 limit+1 条判断截断 | 取 101 条:第 101 行存在即证明截断发生,一次调用同时拿到"前 100 条"和"截断事实",不用再发一次 count 查询 |
| 零运行时依赖 | node:http/fetch/execFile 够用;供应链面小,chat 客户端 ~100 行,每一行都可解释 |

## 已知取舍

- `git_log` 的 since 直接传给 git,模型给错(如未来时间)会得到"无提交"——这是真实结果而非错误,如实回给模型
- 草稿文件名用 ISO 周号 + 标题 slug;同一次跑重名自动 `-2` 避让,不覆盖用户还没看完的上一版
- `read_file` 按 JS 字符截断前先按码点切,避免把 emoji/生僻字切成坏代理对
- Windows 下 `git -c core.quotepath=false` 防中文路径转义;子进程数组传参,无 shell 注入面

## 协作红线

- 四个源仓库(见 config.json)**只读**:只许 git log / read_file,不许写、不许 commit、不许切分支;
- `GLM_API_KEY` 不回显、不入库、不进审计日志;
- 每次运行的完整决策链在 `audit/run-*.jsonl`,review 草稿时随手可查。
