# ARMS Agentic OS

基于 Applications / Routines / Memory / Skills 四层框架的个人智能体操作系统。设计文档见仓库根目录的三份 `*_v1.md`，模块规格见 `docs/superpowers/specs/`。

当前已实现：**Skill Registry & Executor**、**Routine Scheduler**，以及托盘常驻的 **Electron + React 外壳**。

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

## 已知技术债

1. ~~`better-sqlite3` 接 Electron 需要 `electron-rebuild`~~ 已解决：升到 v13 后它是 Node-API 插件，
   走 `prebuilds/` 里的预编译产物，ABI 跨 Node 与 Electron 通用，不需要重编译
2. Skill 扫描只认扫描根下一层子目录的 `SKILL.md`，Skill Tree 的子文件（架构规范 §4.2）不单独索引
3. 护栏字段只入库、不校验；与 connector manifest 的一致性检查留给 Gateway 落地时做
4. `SKILLS_INDEX.md` 目前把用户级 Skill 也一并列入，尚无按来源筛选的开关
5. Routine 重试队列只在内存里，主进程重启会丢掉待重试项（已触发的运行记录不受影响）
6. 托盘图标是 1x1 透明占位图，等真正做视觉时再换
7. `npm run dev` 的热重载链路未做自动化验证，目前只验证了 `npm run build` 产物的启动与交互
8. 测试套件在一次与构建并发的运行里出现过一次未复现的失败；已排掉一处确定的时间依赖（见下），此后 9 次连续运行（含并发负载）全绿，但未能定位原始那次
