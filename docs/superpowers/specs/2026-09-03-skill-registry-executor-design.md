# Skill Registry & Executor 设计规格 v1

- 日期：2026-09-03
- 状态：已批准，进入实现
- 上位文档：`ARMS-Agentic-OS-系统设计文档_v1.md`（§4 模块边界、§5.2 事件总线、§6.1 场景 A、§7 存储、§9 可靠性）、`个人智能体操作系统架构规范_v1.md`（§4 Skill 层规范）、`Connector-Gateway-设计文档_v1.md`（§4 与 Skill 层对齐）

---

## 1. 背景与范围

ARMS Agentic OS 的第一个待办模块。本规格只覆盖 **Skill Registry & Executor**：Skill 的发现、索引、headless 执行、运行记录。

参考实现：`E:\Workspace\agentic-os`（既有 MVP）里的 `src/main/services/skills.ts`、`runs.ts`、`src/main/agents/*` 提供了"扫描 SKILL.md"和"spawn agent CLI"的可借鉴思路，但它只能按裸 prompt 执行、运行记录落 JSONL、没有事件总线。本项目在 `E:\Workspace\arms-os` 下重新实现，不修改 `agentic-os`。

### 明确不做（YAGNI）

Electron 外壳、preload/IPC、Connector Gateway、Routine Scheduler、Memory Indexer、Skill 市场 UI。这些只在接口层面预留。

## 2. 技术选型（已定）

| 项 | 选择 | 理由 |
|---|---|---|
| 落地目录 | `E:\Workspace\arms-os`，全新项目 | 用户决定 |
| 存储 | `better-sqlite3` | 设计文档 §7 要求 SQLite；同步 API、事务完整、支持 FTS5（Memory Indexer 后续要用）。当时判断的代价是「原生模块，接 Electron 需 electron-rebuild」——见下方技术债 1，该判断已被 v13 推翻 |
| 第一步范围 | 主进程核心 + 验证用 CLI | 不开 Electron 就能验证整条链路 |
| Skill 扫描根 | 工作区 + 用户级，可配置 | `<workspace>/.claude/skills` 与 `~/.claude/skills`；同名时工作区优先 |
| 执行方式 | 由 AgentRuntime 决定 | claude runtime 走 slash 命令（`claude -p "/name"`），codex runtime 内联 SKILL.md 正文；差异关在 runtime 内，Executor 只认 skillId |

## 3. 目录结构

```
arms-os/
├─ package.json / tsconfig.json / vitest.config.ts
├─ scripts/arms.ts                   # 验证用 CLI
└─ src/
   ├─ shared/types.ts                # SkillMeta / RunRecord / 事件类型
   └─ main/
      ├─ config.ts                   # scanRoots / workspaceRoot / dbPath / 默认超时
      ├─ db/{index,migrations}.ts    # better-sqlite3 + PRAGMA user_version 迁移
      ├─ bus/index.ts                # 类型化 EventEmitter
      ├─ skills/
      │   ├─ frontmatter.ts guardrails.ts scan.ts parse.ts
      │   ├─ registry.ts             # upsert skills 表；list / get / findByTrigger
      │   └─ indexFile.ts            # 生成 SKILLS_INDEX.md
      ├─ agents/{types,spawn,claude,codex,registry}.ts
      ├─ runs/store.ts               # runs 表 CRUD + runs.log 追加
      └─ executor/index.ts           # SkillExecutor
```

模块边界照系统设计文档 §4：Registry 只管索引（只读），Executor 只管拉进程和写记录。两者都不碰凭据、不判断动作风险等级——那是 Connector Gateway 的 Guardrail 中间件的职责。

## 4. 数据模型（schema v1）

### skills 表

从 `SKILL.md` 解析而来的索引缓存，真相仍在文件系统（§7 原则）。

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | frontmatter `name`，缺省用目录名 |
| `name` / `description` | TEXT | frontmatter |
| `source` | TEXT | `workspace` / `user` |
| `path` | TEXT | SKILL.md 绝对路径 |
| `triggers` | TEXT | JSON `string[]` |
| `model_hint` / `effort_hint` | TEXT NULL | 执行时的默认模型/档位 |
| `forbidden` | TEXT | JSON `string[]`，「绝对不能做的事」 |
| `confirm_required` | TEXT | JSON `string[]`，「需要人工确认的动作」 |
| `connectors` | TEXT | JSON `string[]`，「依赖的 Application」 |
| `lines` | INTEGER | 便于发现超过 150 行该拆 Skill Tree 的文件 |
| `content_hash` | TEXT | sha256，增量索引用：hash 没变不重解析 |
| `indexed_at` | TEXT | ISO 时间 |

存下 `forbidden` / `confirm_required` / `connectors` 是为了将来做 Connector Gateway 文档 §4 那个一致性校验（Skill 声明的高风险动作 vs manifest 里的风险等级），本期只存不校验。

### runs 表

比参考实现的 JSONL 多两个关键字段：

- `skill_id`（可为 NULL，允许裸 prompt 执行）
- `trigger`：`dashboard` / `routine` / `cli` / `chat`——Routine 接入后的统计与排障前提

其余：`label`、`agent`、`model`、`effort`、`cwd`、`command`、`status`、`exit_code`、`started_at`、`ended_at`、`duration_ms`、`output`（截断 16KB）、`error`。索引 `(skill_id, started_at DESC)` 与 `(started_at DESC)`。

迁移用 `PRAGMA user_version`，迁移函数数组按序执行，跑在一个事务里。

## 5. 核心接口

```ts
interface SkillRegistry {
  refresh(): Promise<RefreshResult>            // 增量 upsert，返回 added/updated/removed/unchanged/warnings
  list(): SkillMeta[]
  get(id: string): SkillMeta | undefined
  findByTrigger(text: string): SkillMeta[]
  writeIndexFile(dest: string): Promise<void>  // 生成架构规范 §4.3 的 SKILLS_INDEX.md
}

interface SkillExecutor {
  run(req: SkillRunRequest): RunRecord         // 立刻返回 running 记录，不等执行完
  cancel(runId: string): boolean
  history(opts?: { skillId?: string; limit?: number }): RunRecord[]
}

interface SkillRunRequest {
  skillId: string
  trigger: RunTrigger
  args?: string
  agent?: AgentId       // 默认 config.defaultAgent
  model?: string        // 缺省取 skill.modelHint
  effort?: string       // 缺省取 skill.effortHint
  cwd?: string          // 默认 workspaceRoot
  timeoutMs?: number    // 默认 config.defaultTimeoutMs
  dryRun?: boolean      // 只落库 command，不 spawn
}
```

`model` / `effort` 缺省时取 SKILL.md 的 `model_hint` / `effort_hint`——治理文档 §9 的"模型分级"靠这个默认值生效。

## 6. 事件总线

```
routine:fired        { routineId, skillId, args? }
skill:run:started    { runId, skillId }
skill:run:chunk      { runId, stream, chunk }
skill:run:completed  { runId, status, exitCode, endedAt }
skills:index:updated RefreshResult
```

Executor **订阅** `routine:fired`。下一步接 Routine Scheduler 时，Scheduler 只 emit 事件，Executor 一行不改。

## 7. 错误处理（系统设计 §9）

- **扫描**：单文件读失败或 frontmatter 损坏 → 记 warning、跳过、继续，不中断整轮
- **执行超时**：默认 10 分钟，到点 kill 进程树（Windows 用 `taskkill /T /F`），`status='timeout'`
- **两段落库**：spawn 前先写 `running`（进程崩了也有痕迹），退出后 update
- **启动恢复**：`RunStore.markInterrupted()` 把库里残留的 `running` 全标成 `interrupted`
- **输出截断**：`output` 保留最后 16KB，防 chatty skill 撑爆库
- **Windows 参数引用**：`claude` 在 Windows 上是 `.cmd` shim，必须经 shell 启动；自行按 cmd.exe 规则加引号，不依赖 Node 的 `shell:true` 默认拼接

## 8. 测试策略

vitest。

- `scan` / `parse` / `guardrails` / `frontmatter`：临时目录里的 fixture SKILL.md
- `registry`：`:memory:` 数据库，验证增量（改内容才 updated、删文件才 removed）、工作区覆盖用户级同名
- `executor`：注入假 spawner，**不真 spawn claude**，验证状态机、超时、cancel、两段落库、事件发射
- CLI 提供 `--dry-run`，只打印将执行的命令

## 9. 验证用 CLI

```
tsx scripts/arms.ts skills refresh
tsx scripts/arms.ts skills list
tsx scripts/arms.ts skills show <id>
tsx scripts/arms.ts skills index [dest]
tsx scripts/arms.ts run <id> [--args ...] [--model M] [--effort E] [--agent claude|codex] [--dry-run]
tsx scripts/arms.ts runs [--skill <id>] [--limit N]
```

## 10. 已知技术债

1. ~~`better-sqlite3` 接入 Electron 需要 `electron-rebuild`，Windows 需 VS Build Tools~~
   **已解决（2026-09-04）**：升级到 v13.0.3 后改用 Node-API + `prebuilds/`，同一份 `.node`
   在 Node 22 与 Electron 44 下都能加载，`electron-rebuild` 变成空操作，已从 postinstall 移除。
   期间踩到的两个坑记录在案：v11 的 C++ 用了 Electron 44 的 V8 已删除的 API（`Context::GetIsolate`、
   零参 `External::Value()`、`PropertyCallbackInfo::This`）根本编不过；而在 Electron 33 上重编译虽然成功，
   产物却变成 Electron ABI 专用，当场让 vitest 和 CLI 全部无法加载
2. Skill 扫描目前只认扫描根下的一层子目录 + `SKILL.md`，Skill Tree 的子文件（架构规范 §4.2）不单独索引
3. 护栏字段只入库、不校验；与 Connector manifest 的一致性检查留给 Gateway 落地时做
