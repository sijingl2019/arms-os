# ARMS Agentic OS 系统设计文档 v1

> 这是整套系统的总纲设计文档。与另外两份文档的关系：《个人智能体操作系统架构规范》讲的是**使用层规范**（Skill 怎么写、Memory 路由怎么建、治理规则），本文讲的是**软件系统本身怎么搭**（模块边界、接口契约、数据流、部署形态）；《Connector Gateway 设计文档》是本文里"Connector Gateway"这一个模块的详细设计，本文引用它、不重复它。三份文档共同构成完整设计。

---

## 1. 概述与目标

ARMS Agentic OS 是一个 **Electron + TypeScript + React** 桌面应用，把 Applications / Routines / Memory / Skills 四层能力，加上一个可视化指挥中心（Dashboard），整合成一套可长期运行、可无人值守、可安全审计的个人自动化系统。核心诉求：日常工作沉淀为 Skill；Skill 通过对话、面板按钮、定时任务三种方式触发；触达外部世界的动作统一经过治理层；系统状态在一个仪表盘里一目了然。

---

## 2. 需求

### 2.1 功能性需求
- Dashboard：可自定义组件的看板（Email、Calendar、Skills Deck、Artifacts、Routines、Second Brain 等）
- Skill 系统：Skill 的发现、索引、headless 执行、执行状态回传
- Memory 系统：知识库目录索引、路由文件生成、可视化检索（力导向图谱）
- Routine 系统：定时任务的持久化调度，App 常驻期间可靠触发
- Connector Gateway：统一、受治理的外部连接器访问入口（详见专门设计文档）
- 审计与确认：高风险动作留痕、待办确认队列

### 2.2 非功能性需求
- 单机运行，不依赖任何云端服务即可跑通核心功能
- 常驻后台：即使主窗口关闭，Routine 和 Gateway 仍需在线（托盘常驻）
- 安全：凭据、执行日志、高风险动作审批是贯穿全系统的硬约束，不是某个模块的可选功能
- 性能：知识库规模可达数万文件（参考你 MVP 里 49925 files / 10075 folders 的实测规模），检索和索引不能卡住 UI 线程

### 2.3 约束
- 技术栈已定：Electron + TypeScript + React，Node.js 运行时
- 凭据加密用 Electron `safeStorage`（封装 OS 原生 keychain）
- 智能体执行体（Claude Code / Codex CLI）作为外部子进程调用，而不是把模型能力内嵌进本应用

---

## 3. 总体架构分层

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Renderer 进程 —— Dashboard（React）                 │
│   Micro Apps │ Email │ Calendar │ Skills Deck │ Artifacts │ Routines   │
│   Second Brain（力导向图谱检索） │ Skill 市场 │ 待办确认                    │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │ Electron IPC（contextBridge，唯一通道）
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       主进程 —— OS Core Services                       │
│                                                                        │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐            │
│  │ Skill Registry   │ │ Memory Indexer  │ │ Routine          │        │
│  │ & Executor       │ │                 │ │ Scheduler        │        │
│  │ 索引/触发/记录结果 │ │ 扫描/建路由/建索引│ │ 持久化定时+补跑    │        │
│  └────────┬────────┘ └────────┬────────┘ └────────┬────────┘         │
│           │                    │                    │                 │
│           └──────────┬─────────┴──────────┬─────────┘                 │
│                       ▼                    ▼                          │
│              ┌─────────────────────────────────────┐                  │
│              │     Connector Gateway（独立详细设计）   │                 │
│              │  MCP Server + 中间件链 + Registry      │                 │
│              └───────────────────┬─────────────────┘                  │
│                                  │                                     │
│              ┌───────────────────┴─────────────────┐                  │
│              │   共享存储层：SQLite + 加密凭据 Vault    │                 │
│              └─────────────────────────────────────┘                  │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │ child_process（本机子进程）           │ MCP over HTTP（127.0.0.1）
                ▼                                    ▼
   ┌─────────────────────────┐          ┌─────────────────────────────┐
   │ Agent 运行时               │          │ 外部 Connector                │
   │ claude -p / codex exec   │─────────▶│ Gmail / 日历 / 自建 CLI / 浏览器 │
   │（headless，独立 OS 进程）   │  MCP     │ 自动化                        │
   └─────────────────────────┘          └─────────────────────────────┘
```

**关键结构决定**：Agent 运行时（Claude Code / Codex CLI）作为独立子进程运行，它和 Connector Gateway 之间走标准 MCP over HTTP（即使两者其实都在同一台机器上）——因为 Agent CLI 是外部进程，摸不到 Electron 的 IPC。而 Dashboard 和 OS Core Services 之间是同一个 Electron 应用内部，走 IPC，不必也走 HTTP。这条"内外分界线"贯穿整个系统的接口设计。

---

## 4. 模块边界与职责

| 模块 | 职责 | 明确不做的事 | 数据归属 |
|---|---|---|---|
| **Dashboard（renderer）** | 展示状态、接收用户操作、渲染 Second Brain 图谱 | 不直接读文件系统、不直接持有凭据、不直接连 Connector | 无持久数据，纯前端状态 |
| **Skill Registry & Executor** | 维护 Skill 索引（对应 `SKILLS_INDEX.md`）、headless 触发 Skill（spawn agent CLI）、回收执行结果、写运行记录 | 不管理凭据（凭据在 Gateway/Vault）、不直接决定某个动作是否高风险（那是 Guardrail 的职责） | `skills` 表、`runs` 表 |
| **Memory Indexer** | 扫描知识库目录、生成/更新路由文件（`CLAUDE.md`、`areas/*.md`）、构建供图谱和搜索用的索引 | 不解释 Skill 内容、不触发任何外部调用 | `memory_index` 表 + 路由 `.md` 文件本身 |
| **Routine Scheduler** | 持久化定时任务、App 重启后补跑判断、到点调用 Skill Executor | 不直接触达 Connector（必须经 Skill → Gateway 这条路径） | `routines` 表 |
| **Connector Gateway** | 统一 MCP 入口、中间件链治理、凭据引用管理、下游 connector 适配（见专门设计文档） | 不关心 Skill 内容、不关心知识库 | `connectors` 表、`confirmations` 表 |
| **Credential Vault** | 用 `safeStorage` 加解密凭据 | 不做业务逻辑判断 | 凭据密文（随 SQLite 或本地文件存储） |
| **共享 Audit/Run Store** | 统一的 SQLite 数据库，被以上多个模块共同读写 | —— | 全系统审计记录 |

---

## 5. 模块间接口契约

### 5.1 Renderer ↔ Main（Electron IPC，经 `contextBridge` 暴露）

```ts
// preload 暴露给 renderer 的安全 API（示例）
interface ArmsOsBridge {
  skills: {
    list(): Promise<SkillMeta[]>
    run(id: string, opts: { model?: string; effort?: string; args?: object }): Promise<RunHandle>
    onStatus(cb: (update: RunStatus) => void): () => void   // 事件订阅
  }
  memory: {
    search(query: string): Promise<GraphResult>
    rebuildIndex(scope?: string): Promise<void>
    getIndexStatus(): Promise<IndexStatus>
  }
  routines: {
    list(): Promise<RoutineMeta[]>
    add(def: RoutineDef): Promise<void>
    remove(id: string): Promise<void>
    history(id: string): Promise<RunRecord[]>
  }
  confirmations: {
    list(): Promise<PendingConfirmation[]>
    approve(id: string): Promise<void>
    reject(id: string, reason: string): Promise<void>
    onNew(cb: (item: PendingConfirmation) => void): () => void
  }
}
```

原则：renderer 永远不直接拿到凭据、不直接拼 SQL、不直接 spawn 进程——一切通过这层类型化的 IPC 接口。

### 5.2 Main 内部模块间（同进程，直接函数调用/事件总线）

各模块之间用一个轻量事件总线（Node `EventEmitter` 或等价实现）解耦，例如：

```ts
bus.emit('routine:fired', { routineId, skillId, args })
// Skill Executor 订阅 'routine:fired'，执行对应 skill
bus.emit('skill:run:completed', { runId, status, output })
// 供 Dashboard 的 IPC 事件转发、供 Routine 记录 last_run_status
```

### 5.3 Agent 子进程 ↔ Gateway（外部协议，见 Connector Gateway 设计文档 §3.1、§5）

标准 MCP over HTTP，`127.0.0.1:<port>/mcp`，与 Skill Executor 拉起的 `claude -p` / `codex exec` 子进程解耦——Skill Executor 只负责拉起进程、收集 stdout/退出码，Agent 进程自己按其配置去连 Gateway。

---

## 6. 关键数据流

### 6.1 场景 A：从 Skills Deck 点击按钮执行一个 Skill

1. Dashboard 调 `skills.run('news-digest', {model:'claude-sonnet-5', effort:'medium'})`（IPC）
2. Skill Executor 在 `runs` 表插入一条 `pending` 记录，`spawn('claude', ['-p', '/news-digest', '--model', ..., '--effort', ...])`
3. 若该 Skill 步骤中需要碰外部系统，Claude 子进程通过其自身 MCP 客户端配置连到 `http://127.0.0.1:<port>/mcp`（即 Gateway），走中间件链治理（可能触发确认队列，见场景 D）
4. 子进程退出，Skill Executor 捕获 stdout/退出码，更新 `runs` 表为 `succeeded`/`failed`
5. 通过事件总线 `skill:run:completed` → IPC 推送 → Dashboard 实时刷新 Skills Deck 状态

### 6.2 场景 B：Routine 到点自动触发

1. App 启动时，Routine Scheduler 从 `routines` 表加载所有定义和 `next_run_at`
2. 用定时器（`node-cron` 或自建轮询）在到点时 `bus.emit('routine:fired', ...)`
3. Skill Executor 走场景 A 的 2-4 步（区别是发起方是 Scheduler 而非 Dashboard 点击）
4. **关键前提**：App 需要以"托盘常驻"方式运行（关闭主窗口不退出进程，`tray` 图标 + 可选开机自启），这样就不需要额外一台云端常驻机器也能满足"Routine 在你没盯着屏幕时也能跑"的诉求——相当于用 Electron 自身的托盘能力，把架构规范文档里 Routine L1 的限制往前推了一步，暂时不必跳到 L2（独立云机器）

### 6.3 场景 C：Second Brain 检索

1. Memory Indexer 在后台（建议用 `worker_thread`，避免阻塞主线程/UI）增量扫描配置的知识库目录，更新 `memory_index` 表（文件路径、所属 area、修改时间、摘要）和路由 `.md` 文件
2. Dashboard 调 `memory.search(query)`（IPC），Memory Indexer 查 `memory_index`（数据量大时用 SQLite FTS5 全文索引，避免每次全表扫描）
3. 返回节点+关系数据，Dashboard 渲染成力导向图谱（对应你截图里的效果）

### 6.4 场景 D：高风险动作审批（复用 Connector Gateway 设计文档 §2.3）

Gateway 中间件链判定高风险 → 写入 `confirmations` 表 → 通过事件总线/IPC 推送到 Dashboard 的待办卡片 → 用户批准/拒绝 → Gateway 恢复或终止调用 → 写审计日志。

---

## 7. 数据存储总览

单一 SQLite 文件（如 `arms-os.db`）承载所有结构化状态，文件系统承载"人可编辑的真相来源"：

| 存储对象 | 载体 | 说明 |
|---|---|---|
| Skill 定义本身 | 文件系统 `.claude/skills/**/SKILL.md` | 真相在文件，DB 只存索引缓存 |
| Skill 索引/风险声明 | SQLite `skills` 表 | 从 SKILL.md frontmatter 解析而来，供快速查询 |
| Connector 清单 | 文件系统 YAML manifest | 真相在文件 |
| Connector 缓存 | SQLite `connectors` 表 | 启动时从 manifest 加载 |
| 凭据 | `safeStorage` 加密密文 | 存本地文件或 SQLite 字段，明文只存在解密后的内存里 |
| 运行记录 | SQLite `runs` 表 | 覆盖 Skill 执行和 Gateway 调用两类 |
| 待确认队列 | SQLite `confirmations` 表 | |
| Routine 定义 | SQLite `routines` 表 | cron 表达式、目标 skill、下次触发时间 |
| 知识库索引 | SQLite `memory_index` 表（+ FTS5 虚表） | 供检索和图谱渲染 |
| 路由文件 | 文件系统 `CLAUDE.md` / `areas/*.md` | 真相在文件，Memory Indexer 负责保持同步 |

原则延续 ARMS"一切皆文件"的哲学：**凡是用户会想手动编辑、纳入版本管理的东西（Skill、manifest、路由文件），放文件系统；凡是系统内部状态、需要事务性和查询效率的东西（运行记录、索引缓存、审批队列），放 SQLite。**

---

## 8. 进程与部署模型

- 单进程 Electron 应用，主进程内再按模块划分（非独立子进程），Skill 执行时才 spawn 短生命周期的 agent CLI 子进程，浏览器自动化 Connector 也是独立子进程（隔离风险，见下）
- Memory Indexer 的全量扫描/重建索引用 `worker_thread` 跑，避免大目录（数万文件级别）扫描卡住主线程，进而卡住 Gateway 和 IPC 响应
- 应用需支持"最小化到系统托盘、后台持续运行"，这是 Routine 可靠触发的前提条件
- Gateway 的 HTTP Server 只在 App 就绪后启动，只监听 `127.0.0.1`

---

## 9. 可靠性与容错

- Gateway 的每个 `ConnectorAdapter` 调用都要有超时/熔断，单个下游 connector 故障不拖垮 Gateway 整体（详见 Connector Gateway 设计文档 §7）
- Skill Executor 拉起的 agent 子进程若长时间无输出/挂起，需要设置整体执行超时并强制 kill，避免一个 Skill 卡死占用资源
- Memory Indexer 扫描失败（比如某个文件权限拒绝）应跳过并记录警告，不能让一个坏文件中断整个索引重建
- Routine Scheduler 需要处理"App 重启后错过的触发"：记录 `next_run_at`，重启时判断是否需要补跑，策略应可配置（跳过 / 补跑一次）

---

## 10. 安全边界总览（贯穿全系统）

- 凭据只在 Credential Vault 内以密文存在，业务代码只持有 `credential_ref`，实际解密只发生在真正调用下游 connector 的那一刻
- 高风险动作的拦截点只有一个：Gateway 的 Guardrail 中间件，不允许任何模块绕过它直接触达 Connector
- Renderer 进程遵循 Electron 安全最佳实践：`contextIsolation: true`、`nodeIntegration: false`，一切能力通过 `contextBridge` 显式暴露的最小接口获取，不给 renderer 直接的 Node.js 能力
- MCP HTTP 端点只本地监听，不暴露公网/局域网

---

## 11. 与既有 MVP 的衔接

你截图里的 MVP（Dashboard 布局、Second Brain 图谱、Skills Deck）对应本设计里的 Renderer 层，可以保留现有 UI，逐步把背后的数据来源从"占位/静态"换成真正调用 Skill Registry / Memory Indexer / Routine Scheduler 的 IPC 接口。建议顺序：先接 Skills Deck 的真实执行（场景 A），再接 Routine 持久化调度（场景 B，顺带解决截图里"仅在本应用运行时触发"的提示语），再接 Connector Gateway（场景 D 的确认流程），最后是 Memory Indexer 的增量索引优化（应对"Index hit its file cap"这个你截图里已经暴露的规模问题）。

---

## 12. 后续拆分点（现在不用做，先记下）

- 若未来要支持"电脑关机也能跑 Routine"（架构规范文档里的 Routine L2），Gateway 和 Scheduler 需要从 Electron 主进程里拆出来，做成可以单独部署到常驻云机器的独立 Node 服务——现在把它们设计成主进程内的"模块"而不是散落的全局函数，就是在为这一步拆分留退路
- 若未来要多机共享凭据/状态，SQLite 和 `safeStorage` 都需要替换成支持多机的方案（参考 Connector Gateway 设计文档 §8 的权衡取舍）
