# ARMS Agentic OS

基于 Applications / Routines / Memory / Skills 四层框架的个人智能体操作系统。设计文档见仓库根目录的三份 `*_v1.md`，模块规格见 `docs/superpowers/specs/`。

当前已实现：**Skill Registry & Executor**、**Routine Scheduler**、**Connector Gateway**（MCP over HTTP + Guardrail），以及托盘常驻的 **Electron + React 外壳**。

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

`run` 的参数：`--args`、`--agent claude\|codex`、`--model`、`--effort`、`--cwd`、`--timeout <ms>`、`--dry-run`。
全局：`--workspace <dir>`。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ARMS_WORKSPACE` | `process.cwd()` | 工作区根目录，也是 Skill 运行时的默认 cwd |
| `ARMS_STATE_DIR` | `~/.arms-os` | 数据库和 `runs.log` 的位置 |

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
12. 设计文档 §7 把 Gateway 调用记在 `runs` 表，实现里另建了 `tool_calls` 表——两者列几乎不重叠（run 有命令行/退出码/流式输出，tool call 有 connector/JSON 参数/风险判定），合表会让任一种行有一半是 NULL
