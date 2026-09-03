# ARMS Agentic OS

基于 Applications / Routines / Memory / Skills 四层框架的个人智能体操作系统。设计文档见仓库根目录的三份 `*_v1.md`，模块规格见 `docs/superpowers/specs/`。

当前已实现：**Skill Registry & Executor**（主进程核心 + 验证用 CLI）。Electron / React 外壳尚未搭建。

## 快速开始

```bash
npm install
npm test
npx tsx scripts/arms.ts doctor
```

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
| `arms runs [--skill <id>] [--limit N]` | 最近的运行记录 |

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
  shared/types.ts        跨进程契约：SkillMeta / RunRecord / 事件类型
  main/
    config.ts            扫描根、路径、默认超时
    db/                  better-sqlite3 + PRAGMA user_version 迁移
    bus/                 类型化事件总线（系统设计文档 §5.2）
    skills/              frontmatter / 护栏解析 / 扫描 / 注册表 / SKILLS_INDEX 生成
    agents/              AgentRuntime 抽象 + claude / codex + 进程 spawn
    runs/                runs 表 + runs.log
    executor/            SkillExecutor
    core.ts              组合根
scripts/arms.ts          验证用 CLI
```

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

1. `better-sqlite3` 是原生模块，接 Electron 时需要 `electron-rebuild`（Windows 需 VS Build Tools）
2. Skill 扫描只认扫描根下一层子目录的 `SKILL.md`，Skill Tree 的子文件（架构规范 §4.2）不单独索引
3. 护栏字段只入库、不校验；与 connector manifest 的一致性检查留给 Gateway 落地时做
4. `SKILLS_INDEX.md` 目前把用户级 Skill 也一并列入，尚无按来源筛选的开关
