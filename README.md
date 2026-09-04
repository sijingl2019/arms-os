# ARMS Agentic OS

基于 Applications / Routines / Memory / Skills 四层框架的个人智能体操作系统。设计文档见仓库根目录的三份 `*_v1.md`，模块规格见 `docs/superpowers/specs/`。

当前已实现：**Skill Registry & Executor**、**Skill 体检**、**Routine Scheduler**、**Connector Gateway**（MCP over HTTP + Guardrail）、**Memory Indexer**（增量索引 + FTS5 检索 + 路由文件生成），以及托盘常驻的 **Electron + React 外壳**。

## 快速开始

```bash
npm install
npm run dev          # 启动 Electron 外壳
npm test
npx tsx scripts/arms.ts doctor   # 不开界面时用 CLI 验证
```

> `npm install` 会顺带下载 Electron 二进制（约 245MB）。这一步靠本项目的
> `postinstall: install-electron` 触发——**Electron 从 v43 起移除了自己的 postinstall**，
> 不显式调用就只会装个空壳包。首次下载走 `.npmrc` 里配置的镜像；装过一次后有本地缓存，
> 重装只要几秒。

`doctor` 会打印解析出的工作区、状态目录和 Skill 扫描根。确认无误后：

```bash
npx tsx scripts/arms.ts skills refresh
npx tsx scripts/arms.ts skills list --source workspace
npx tsx scripts/arms.ts run news-digest --dry-run
```

`--dry-run` 只记录将要执行的命令行，不真的拉起 agent 进程——先用它确认命令拼对了，再去掉这个参数真跑。

## CLI

| 命令 | 作用 |
|---|---|
| `arms doctor` | 打印解析后的配置、扫描根、已索引数量 |
| `arms skills refresh` | 重扫所有扫描根，增量更新 `skills` 表 |
| `arms skills list [--source workspace\|user]` | 列出已索引的 Skill |
| `arms skills show <id>` | 展开单个 Skill，含三段护栏 |
| `arms skills match <text>` | 按 `triggers` 把自由文本解析成 Skill |
| `arms skills index [dest]` | 生成 `SKILLS_INDEX.md`（架构规范 §4.3） |
| `arms skills doctor [--all] [--strict]` | Skill 体检；`--strict` 有 error 时退出码 1 |
| `arms skills new <id>` | 从模板新建 Skill（护栏章节已就位） |
| `arms run <id> [options]` | headless 执行一个 Skill |
| `arms runs [--skill <id>] [--routine <id>] [--limit N]` | 最近的运行记录 |
| `arms routines list` | 列出 routine 及下次触发时间 |
| `arms routines add --name N --skill S --cron "0 9 * * *"` | 新建 routine |
| `arms routines set <id>` / `rm <id>` | 修改 / 删除 |
| `arms routines tick [--at <iso>] [--dry-run]` | 手动跑一轮调度（dry-run 会摘掉 Executor） |
| `arms routines export <id>` | 生成系统级定时任务命令 |
| `arms gateway status` | connector、tool 及其风险等级 |
| `arms gateway serve` | 前台跑 MCP 端点直到 Ctrl+C |
| `arms gateway calls` / `pending` | 调用审计 / 待批准队列 |
| `arms gateway approve <id>` / `reject <id>` | 批准 / 拒绝 |
| `arms memory status` | 知识库根、领域分布、索引规模 |
| `arms memory index [--force] [--router]` | 增量重扫（`--force` 全量重读） |
| `arms memory search <text> [--area A]` | 全文检索 |
| `arms memory router [--dry-run]` | 生成 `CLAUDE.md` 与 `areas/*.md` |

`run` 的参数：`--args`、`--agent claude\|codex`、`--model`、`--effort`、`--cwd`、`--timeout <ms>`、`--dry-run`。
全局：`--workspace <dir>`。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ARMS_WORKSPACE` | `process.cwd()` | 工作区根目录，也是 Skill 运行时的默认 cwd |
| `ARMS_STATE_DIR` | `~/.arms-os` | 数据库和 `runs.log` 的位置 |
| `ARMS_MEMORY_ROOTS` | 空 | 知识库目录，多个用系统路径分隔符隔开。不配就不索引 |

Skill 扫描根默认两个：`~/.claude/skills`（`user`）和 `<workspace>/.claude/skills`（`workspace`）。同名时工作区覆盖用户级。

## 模块结构

```
src/
  shared/
    types.ts             跨进程契约：SkillMeta / RunRecord / RoutineDef / 事件 / IPC 接口
    channels.ts          IPC 频道名
  main/
    index.ts             Electron 入口：单实例锁、托盘常驻、窗口、生命周期
    ipc/register.ts      ipcMain.handle 绑定 + 事件总线转发到 renderer
    config.ts            扫描根、路径、默认超时
    db/                  better-sqlite3 + PRAGMA user_version 迁移
    bus/                 类型化事件总线（系统设计文档 §5.2）
    skills/              frontmatter / 护栏解析 / 扫描 / 注册表 / SKILLS_INDEX 生成
    agents/              AgentRuntime 抽象 + claude / codex + 进程 spawn
    runs/                runs 表 + runs.log
    routines/            RoutineStore + Scheduler + 系统级任务导出
    gateway/             manifest / registry / 适配器 / 中间件链 / 确认队列 / MCP HTTP Server
    memory/              walk / extract / store(FTS5) / 增量 indexer / 路由文件生成
    executor/            SkillExecutor
    core.ts              组合根
  preload/index.ts       contextBridge 暴露的唯一通道
  renderer/src/          React Dashboard：Skills / Routines / Runs / System
scripts/arms.ts          验证用 CLI
```

## Routine

Scheduler 用 croner 算出 `next_run_at` 并落库，配一个 20 秒 tick 循环去比对墙上时钟——不给每个 routine 挂 setTimeout，因为定时器会漂移、机器睡过一次触发就永远丢了。

它只往总线 emit `routine:fired`，真正执行的是 Executor。**托盘常驻**是可靠触发的前提：关窗口只是隐藏，进程和调度器继续跑。

- **错过的触发默认跳过**（`missedRunPolicy=skip`）。开机补一堆任务正是重复副作用的来源；需要时可设 `catch-up-once`，且无论错过几次只补一次。
- **幂等**：上一轮还在跑就跳过本次，不叠着跑。
- **重试**：`maxRetries` / `retryDelayMs` 显式声明，默认不重试。
- **cron 写入时即校验**，非法表达式当场拒绝，不会出现"配置看起来成功、实际永不触发"。
- **Routine L2 逃生舱**：`routines export` 生成 `schtasks` / `crontab` / `launchd` 命令让你自己去注册——绝不背着你注册系统级任务。生成的任务回调本 CLI 的 `arms run`，所以运行记录仍然落库。

**边界**：Registry 只读索引，Executor 只拉进程和写记录。两者都不持有凭据、不判断动作风险等级——那是 Connector Gateway 的 Guardrail 中间件的唯一职责。

## 两个 Runtime 的差异

| | claude | codex |
|---|---|---|
| 命令 | `claude -p "/<name> <args>" --model M --effort E` | `codex exec "<内联 SKILL.md>" --model M` |
| 谁加载 SKILL.md | Claude Code 自己（slash 命令） | 我们内联进 prompt（codex 无 slash 机制） |

差异关在 `AgentRuntime` 里，Executor 只认 skill id。

## 事件

```
routine:fired        Routine Scheduler 将来只需 emit 这个，Executor 已订阅
skill:run:started
skill:run:chunk      stdout / stderr 流式
skill:run:completed
skills:index:updated
```

## Skill 体检

把架构规范 §11 的上线前自检清单机器化，外加 Connector Gateway 设计文档 §4 点名要做的那个校验脚本。

```bash
npx tsx --tsconfig tsconfig.node.json scripts/arms.ts skills doctor --strict
```

规则分三级。`error`：没声明「绝对不能做的事」、触发词冲突、**依赖的 connector 含不可逆动作却没声明任何需要确认的动作**。`warning`：没有 description、依赖了 Application 却没声明确认项、声称有高风险动作但 connector 全是 read-only。`info`：没有触发词、超过 150 行该拆 Skill Tree、依赖的 connector 在 manifest 里找不到。

**核心是那条"两张皮"校验**（Gateway 文档 §4）：Skill 说自己会小心，Gateway 却没设防——或者反过来。两个方向都查。Gateway 始终会拦截，所以这不是安全兜底，而是让文档与实际风险不再脱节。

默认只体检 `workspace` 来源的 Skill：用户级和插件 Skill 从来不是照这套规范写的，也不归你改；`--all` 可以全查。`--strict` 让它能当 pre-commit 闸门用。

`arms skills new <id>` 从架构规范 §4.1 模板生成 SKILL.md，三个护栏章节预先就位——需要靠记性补的章节就是会被跳过的章节。

## Memory Indexer

知识库根由 `ARMS_MEMORY_ROOTS` 配置，**独立于 `workspaceRoot`** —— 几万文件的知识库通常不在代码工作区里。

**没有文件上限。** 旧 MVP 卡在 6 万文件封顶，因为它把整棵树读进内存再一次性落盘。现在 walk 是流式的、写入按批次，峰值内存与库大小无关。索引一半却不吭声，比慢一点更糟。

**只读改动过的文件。** 一轮扫描对所有文件 `stat`，但只打开 mtime 或 size 变了的。用 mtime+size 而不是内容哈希：5 万文件每轮全哈希的代价远超收益；哈希才能发现的那种"改了但 mtime/size 都没变"的编辑，用 `--force` 兜底。

**50k 文件实测**（`npm run bench:memory`，Windows）：

| | 数值 |
|---|---|
| 首次索引 | 32s / 50000 files，无上限、无警告 |
| 无变化重扫 | **3.2s** |
| 改 1 个文件后重扫 | **3.0s** |
| 中文子串搜索 | 57–120ms |
| 索引库体积 | 171 MB |
| 事件循环最大卡顿 | **98ms** |

两处优化都是量出来的，不是猜的：并行 `stat`（重扫 10.1s → 3.2s）、把 SQLite 批次从 500 降到 100 并在批间让出事件循环（卡顿 325ms → 98ms）。

**分词器用 trigram，不是 unicode61。** 实测 unicode61 对中文子串**一个都匹配不到**（它把整段 CJK 当成一个 token）；trigram 能匹配 3 字及以上的中文子串，英文也照常。trigram 的下限是 3 个字符，所以 1–2 字的查询会退回到有界的 `LIKE`（只匹配文件名和标题），而不是静默返回空。

**路由文件生成**（架构规范 §5.1）：`arms memory router` 生成 `CLAUDE.md` 主路由和 `areas/*.md` 领域索引。它**只改两个标记之间的内容**，标记之外一个字节都不碰；没有标记的文件是追加而不是覆盖；写入是原子的，且内容没变就不写。默认写到**知识库根**，不是代码仓——否则会改掉本仓库手写的 `CLAUDE.md`。

## Connector Gateway

所有触达外部世界的动作**只有这一个入口**，Guardrail 是唯一的强制拦截点。Agent 只配一个地址：

```bash
claude mcp add --transport http arms-gateway http://127.0.0.1:39217/mcp
codex  mcp add arms-gateway --url http://127.0.0.1:39217/mcp
```

它不知道背后有几个真实 connector。工具名统一 `<connector>.<tool>`，换实现不影响 agent 侧。

**风险三档，精确到每个 tool**（`connectors/manifest.yaml`，从 `.example` 复制）：

| 等级 | 行为 |
|---|---|
| `read-only` | 直接放行 |
| `write-reversible` | 放行，审计里高亮 |
| `write-irreversible` | **阻塞**，直到你在 Dashboard 点批准 |

**没写 `default_risk` 就是最严档。** 这是故意的：connector 作者只能主动往下调，不能因为忘了标注而意外放行。同理，看不懂的风险标签也一律按最严处理。

**审批是阻塞式的**：`tools/call` 一直挂着直到你批准/拒绝或超时（默认 5 分钟），然后返回真实结果。设计文档 §2.3 原本写的是立刻返回占位符让 agent 轮询——实践中 agent 会把占位符当成功继续往下跑，所以改成阻塞。有审批待处理时托盘 tooltip 会提示，窗口会自动弹出。

中间件链顺序在 `dispatcher.ts` 一处声明：审计 → schema 校验 → 限流 → **Guardrail** → 熔断。审计**包在最外层**，因为被拦下的调用恰恰是最该进日志的。

凭据只以 `vault://<id>` 引用形式出现在 manifest 里，解密发生在真正调用下游的那一刻，且只进子进程环境变量、绝不上命令行（命令行会进审计日志）。

## 已知技术债

1. ~~`better-sqlite3` 接 Electron 需要 `electron-rebuild`~~ 已解决：升到 v13 后它是 Node-API 插件，
   走 `prebuilds/` 里的预编译产物，ABI 跨 Node 与 Electron 通用，不需要重编译
2. Skill 扫描只认扫描根下一层子目录的 `SKILL.md`，Skill Tree 的子文件（架构规范 §4.2）不单独索引
3. 护栏字段只入库、不校验；与 connector manifest 的一致性检查留给 Gateway 落地时做
4. `SKILLS_INDEX.md` 目前把用户级 Skill 也一并列入，尚无按来源筛选的开关
5. Routine 重试队列只在内存里，主进程重启会丢掉待重试项（已触发的运行记录不受影响）
6. 托盘图标是 1x1 透明占位图，等真正做视觉时再换
7. `npm run dev` 的热重载链路未做自动化验证，目前只验证了 `npm run build` 产物的启动与交互
8. ~~测试套件偶发失败未定位~~ 已解决：Windows 上的 `EBUSY`。`runs.log` 是有意的 fire-and-forget 写入（日志失败不能让运行失败），临时目录清理时写入还没落盘。顺带修掉一个真问题：退出时未完成的日志追加会丢——`RunStore.flush()` 现在会在 `close()` 里等它写完
9. `BrowserAdapter` 只有接口没有实现，调用会明确报错——架构规范 §7.1 本来就把浏览器自动化定为最后手段
10. Gateway 的 schema 校验是浅校验（必填字段 + 基本类型），不是完整 JSON Schema 验证器；它只拦明显畸形的调用，真正的安全边界是 Guardrail
11. 限流与熔断是进程内内存状态，重启即清零
12. Memory Indexer 跑在主进程里，没有用设计文档 §8 建议的 `worker_thread`。实测最大卡顿 98ms（且只在全量重建时出现），renderer 是独立进程不受影响，代价只是 IPC 延迟——为此引入独立 DB 连接和 WAL 竞争暂时不划算。若将来全量重建变频繁再补
13. 只索引正文前 8KB，长文档的尾部搜不到
14. Skill 体检里「依赖的 Application」是自由文本，靠在其中匹配已知 connector id 来关联；写法完全不含 id 时不会触发交叉校验（因此报 info 而非 error）
15. "Skill 市场"（远程仓库拉取 skill 包）未做：设计文档里只有框图上的一个词，包格式、来源信任、版本升级都还没有规格
14. 设计文档 §7 把 Gateway 调用记在 `runs` 表，实现里另建了 `tool_calls` 表——两者列几乎不重叠（run 有命令行/退出码/流式输出，tool call 有 connector/JSON 参数/风险判定），合表会让任一种行有一半是 NULL
