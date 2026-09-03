# Connector Gateway 设计文档 v1

> ARMS Agentic OS 的核心模块：作为 Claude Code / Codex CLI 唯一声明的连接器入口，内部聚合、治理所有真实下游 connector。本设计遵循「需求 → 高层设计 → 深挖 → 可靠性 → 权衡」的系统设计框架。

---

## 0. 结论先行（研究校正，请注意这一条修正了上次讨论的判断）

上次我判断 Codex 大概率走 function-calling 而非 MCP，需要单独做一套协议适配器。查证后发现这个判断需要修正：

- **Codex CLI 是 MCP 客户端**，支持 STDIO（本地进程）和 Streamable HTTP（远程 URL）两种传输，接入方式是 `codex mcp add <name> --url <url>`，鉴权走 `codex mcp login <name>`，配置落在 `config.toml`。
- **Claude Code** 接入远程 MCP Gateway 的标准方式是 `claude mcp add --transport http <name> <url>`，业界已经有多个现成的 MCP Gateway 项目（如 Bifrost）在做"聚合多个下游 MCP Server、对外暴露单一 `/mcp` 端点"这件事，Claude Code 侧完全不感知下游有多少个真实 connector。

结论：**当前只需要实现一套标准 MCP over HTTP Server，Claude 和 Codex 可以共用同一个 Gateway 地址**，不需要现在就做两套协议适配器。"协议适配器"这个抽象层仍然保留（见第 5 章），但目前它是一个"空实现"，只有未来接入不支持 MCP 的智能体时才需要真正扩展。

Sources:
- [Codex MCP Setup: Add MCP Servers to OpenAI Codex (CLI + Desktop, 2026)](https://matagi.ai/blog/guides/how-to-add-mcp-servers-to-codex)
- [Using an MCP Gateway with Claude Code: A Practical Guide](https://www.getmaxim.ai/articles/using-an-mcp-gateway-with-claude-code-a-practical-guide/)
- [Top 5 MCP Gateways for Claude Code in 2026](https://www.getmaxim.ai/articles/top-5-mcp-gateways-for-claude-code-in-2026/)

---

## 1. 需求

### 1.1 功能性需求
- 单一入口：Claude Code / Codex CLI 只配置一个 Gateway 地址，通过它够到所有下游 connector（Gmail、日历、自建 CLI、浏览器自动化等）
- 统一发现：新增/下线一个下游 connector，agent 端配置不用变
- **强制护栏**：写操作/不可逆操作在真正执行前，能被系统拦截转人工确认，而不是依赖 Skill 文本里的自觉声明
- 集中凭据：所有下游凭据只存在 Gateway 一处，Skill/agent 侧永远看不到明文
- 可观测：每次 tool 调用有日志、耗时、结果、花费记录，供指挥中心展示
- 限流/成本控制：按 connector、按 skill 可设调用频率和预算上限
- 热替换：换下游实现（比如网页模拟换成官方 API）不影响 agent 侧调用方式

### 1.2 非功能性需求
- 规模：个人/小团队使用，QPS 很低，设计目标是**正确性和安全性优先**，不是高并发吞吐
- 延迟：本地/局域网部署，可接受比直连下游多 50-200ms 的中间件开销
- 可用性：作为常驻后台服务运行，不依赖某个前端窗口开着（修正上次截图里 Routine "仅在本应用运行时触发"的限制）
- 安全：凭据存储是最高优先级；必须假设 Skill 的提示词可能被注入攻击，Gateway 是最后一道防线，不能只信任 agent 的"自觉"

### 1.3 约束
- 个人/小团队开发能力，倾向 Node.js（MCP 官方 TypeScript SDK 更成熟）或 Python
- 需要兼容你已在用的官方 MCP（Gmail、Google Drive 等），不能推翻重接
- 要能被 Dashboard 通过 HTTP API 读取状态、发起确认动作

---

## 2. 高层设计

### 2.1 组件图

```
                ┌─────────────────────────────────────────────┐
                │                Dashboard（前端）                │
                │  Email / Skills Deck / Routines / 待办确认      │
                └───────────────┬───────────────────────────────┘
                                │ HTTP（状态查询 / 确认动作）
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                    ARMS Connector Gateway（常驻服务）                 │
│                                                                     │
│  ┌────────────────┐       ┌───────────────────────────────────┐   │
│  │  MCP Server      │◀────▶│   Dispatcher（前端控制器）           │   │
│  │  (HTTP 传输)      │ JSON │   路由 tool 调用到对应 connector 适配器│   │
│  │  tools/list       │ RPC  └───────────────┬───────────────────┘   │
│  │  tools/call       │                      │                       │
│  └────────────────┘                        ▼                       │
│  ▲ Claude Code / Codex CLI 只连这一个地址                             │
│                          ┌───────────────────────────────────┐      │
│                          │        中间件链（顺序执行）             │     │
│                          │ 1. SchemaValidate                  │     │
│                          │ 2. AuthN/AuthZ（身份+权限）           │     │
│                          │ 3. Guardrail（风险分级+人工确认）      │     │
│                          │ 4. RateLimit / Cost                │     │
│                          │ 5. Logging / Audit                 │     │
│                          │ 6. Retry / CircuitBreaker          │     │
│                          └───────────────┬───────────────────┘     │
│                                          ▼                          │
│         ┌───────────────────────────────────────────────┐          │
│         │        Connector Registry（manifest 驱动）        │         │
│         │  gmail        → MCP passthrough                 │         │
│         │  calendar     → MCP passthrough                 │         │
│         │  weibo-post   → 自建 CLI adapter                 │         │
│         │  legacy-app   → 浏览器自动化 adapter               │         │
│         └───────────────┬───────────────────────────────┘          │
│                         ▼                                          │
│      ┌─────────────────────────┐   ┌───────────────────────┐      │
│      │  Credential Vault（加密）  │   │ Audit/Run Store(SQLite) │     │
│      └─────────────────────────┘   └───────────────────────┘      │
└───────────────────────────────────────────────────────────────────┘
                            │
    ┌────────────┬──────────┼───────────┬─────────────┐
    ▼            ▼          ▼           ▼             ▼
官方 Gmail    官方日历    自建 weibo   浏览器自动化   其他 MCP/API/CLI
MCP Server    MCP/API     CLI 脚本    (Playwright)
```

### 2.2 数据流 —— 正常只读调用

1. Claude/Codex 通过 MCP 调 `tools/call(name="gmail.search_threads", args)`
2. Dispatcher 查 Registry，得知 `gmail` → MCP passthrough adapter + 对应凭据引用
3. 中间件链依次执行：schema 校验 → 鉴权（这个 session 是否有权限调 `gmail.*`）→ Guardrail 判断（`search_threads` 是 read-only，直接放行）→ 限流检查 → 记录审计日志（进行中）→ 转发到真实 Gmail MCP Server → 拿到结果 → 记录审计日志（完成，耗时 X ms）→ 原样返回给 agent

### 2.3 数据流 —— 高风险写操作（举例：`weibo-post.publish`）

1. agent 调 `tools/call(name="weibo-post.publish", args)`
2. 中间件跑到 Guardrail 这一步，查到该 tool 的 `risk_level = write-irreversible`
3. Guardrail **不放行**，把整次调用存入"待确认队列"（SQLite 表 `pending_confirmations`），返回 agent 一个占位结果：`{status:"pending_confirmation", confirmation_id:"..."}`
4. Dashboard 的"待办"卡片轮询该队列，展示给你，你点"批准"或"拒绝"
5. 批准 → Gateway 恢复执行、继续走剩余中间件、真正调用下游；拒绝 → 直接返回失败结果给 agent，附带拒绝原因
6. 无论结果如何，都写入审计日志（谁在何时批准/拒绝）

---

## 3. 接口契约

### 3.1 对外（agent 侧）：标准 MCP over HTTP
不自定义协议——直接实现 MCP 规范的 `tools/list`、`tools/call`（可选 `resources/*`），保证 Claude Code / Codex CLI 用官方 SDK 直接可接。工具名统一加 connector 前缀防冲突，如 `gmail.search_threads`、`weibo-post.publish`。

### 3.2 内部：Connector 适配器接口（与传输方式无关）

```ts
interface ConnectorAdapter {
  id: string                     // "gmail" | "weibo-post" | ...
  listTools(): ToolSpec[]
  callTool(toolName: string, args: object, ctx: CallContext): Promise<ToolResult>
}
```

三种实现对应 Applications 层的三种通道：
- `McpPassthroughAdapter`：内部开一个 MCP client 连官方/社区 MCP Server，原样透传
- `CliAdapter`：内部 spawn 子进程跑自建 CLI，解析 stdout 为 `ToolResult`
- `BrowserAdapter`：驱动 Playwright 之类，仅用于没有官方通道的兜底场景

### 3.3 中间件接口（Koa/Express 风格，可插拔）

```ts
type Middleware = (ctx: CallContext, next: () => Promise<ToolResult>) => Promise<ToolResult>
```

顺序在 Gateway 启动配置里声明，新增一个中间件（比如"成本预算"）不需要改其他代码。

### 3.4 Connector 注册清单（manifest，YAML，人可读可编辑）

```yaml
- id: gmail
  transport: mcp-stdio          # mcp-stdio / mcp-http / cli / browser
  command: ["npx", "-y", "@modelcontextprotocol/server-gmail"]
  credential_ref: vault://gmail-oauth
  default_risk: read-only
  overrides:
    send_message: write-reversible
    trash_message: write-irreversible

- id: weibo-post
  transport: cli
  command: ["node", "connectors/weibo-post/cli.js"]
  credential_ref: vault://weibo-cookie
  default_risk: write-irreversible
```

`overrides` 允许同一个 connector 内不同 tool 有不同风险等级——精确到工具而不是整个 connector 一刀切，这与业界通行做法（按工具而非按服务器发放权限）一致。

### 3.5 确认队列 HTTP API（供 Dashboard 调用）

```
GET  /confirmations/pending
POST /confirmations/:id/approve
POST /confirmations/:id/reject   { reason }
```

---

## 4. 深挖：Guardrail 中间件

**风险三档**：`read-only`（直接放行）/ `write-reversible`（放行但高亮记录，比如"存草稿"）/ `write-irreversible`（必须人工确认，比如"发布""删除""付款"）。

**分级来源**：manifest 里 connector 级别的 `default_risk` + 具体工具的 `overrides`；新工具若忘记标注，默认按最严档处理（fail-safe：宁可多问一次，不可少问一次）。

**超时策略**：待确认项默认 24 小时未处理自动拒绝并通知，避免 agent 无限期挂起等待。

**与 Skill 层对齐**：Skill 的 `SKILL.md` 里"需要人工确认的动作"字段，从现在起不再只是文档说明——理想情况下应有一个小校验脚本，检查 Skill 声明的高风险动作是否在 Gateway manifest 里也标了对应等级，两边不一致就报警，避免"Skill 说会小心，Gateway 却没设防"的两张皮问题。

---

## 5. 深挖：协议适配层（结论见第 0 章）

当前只需一个 MCP HTTP Server 实现：

- Claude Code 接入：`claude mcp add --transport http arms-gateway http://localhost:PORT/mcp`
- Codex CLI 接入：`codex mcp add arms-gateway --url http://localhost:PORT/mcp`，如需鉴权再执行 `codex mcp login arms-gateway`

协议适配器目前是"空适配器"（就是标准 MCP），保留这个抽象层是为了未来接入不支持 MCP 的智能体时，只需新增一个适配器模块，不用改动 Dispatcher 和中间件链。

---

## 6. 存储选型

- **审计日志 / 待确认队列 / 调用统计**：SQLite 单文件数据库——本地、零运维、事务性够用；未来要多机共享状态时再换 Postgres
- **凭据**：加密存储（优先用 OS 原生 keychain，退而求其次用 age/gpg 加密的本地文件），绝不在 manifest 里明文出现
- **Connector 清单**：YAML 文件，纳入工作区版本管理，延续 Memory 层"一切皆文件"的原则

---

## 7. 规模与可靠性

个人/小团队场景不需要考虑水平扩展，真正要防的是"单点故障 = 所有 App 一起断"：

- Gateway 作为系统服务（进程管理器守护）常驻，崩溃自动重启
- 单个下游 connector 挂掉，只影响该 connector 的工具报错，不拖垮整个 Gateway（每个 adapter 调用要加超时和熔断）
- 定期归档/瘦身 SQLite 审计库，避免无限增长

---

## 8. 权衡取舍

- **SQLite 而非数据库服务**：牺牲未来多机共享状态的能力，换取现在零运维——个人场景够用，多机时是需要偿还的技术债
- **Guardrail 默认最严格而非默认放行**：牺牲一点使用顺滑度，换取安全兜底
- **只实现 MCP 一种协议**：省了当前开发量，代价是未来若接入不支持 MCP 的智能体需要回来补协议适配层——但目前证据显示 Claude Code 和 Codex CLI 都已支持，这个代价短期内不太会兑现

---

## 9. 技术决策（已确定）

1. **语言/运行时**：Node.js + TypeScript
2. **部署位置**：Gateway 与 Dashboard 同机运行，当前只考虑单机场景
3. **凭据加密**：OS 原生 keychain

以上决定的前提是：Dashboard 本身是一个 **Electron + TypeScript + React** 项目。这个前提让 Gateway 的落地方式比第 2 章的通用设计更具体，见第 10 章。

---

## 10. 基于 Electron + TypeScript + React 项目的落地设计

### 10.1 进程模型：Gateway 是主进程里的一个模块，不是独立服务

Electron 主进程本身就是 Node.js 运行时，所以 Dispatcher、中间件链、Connector Registry、Credential Vault、SQLite 审计库都直接跑在主进程里，**不需要**额外 spawn 一个独立的 Node 服务再互相通信。建议目录结构（并入你现有项目）：

```
src/
  main/
    gateway/
      dispatcher.ts        # 前端控制器
      middlewares/
        schemaValidate.ts
        auth.ts
        guardrail.ts
        rateLimit.ts
        logging.ts
        retry.ts
      registry.ts           # 读取 manifest，管理 ConnectorAdapter 实例
      adapters/
        mcpPassthrough.ts
        cli.ts
        browser.ts
      vault.ts               # 封装 Electron safeStorage
      mcpServer.ts           # 对外 MCP over HTTP，仅监听 127.0.0.1
      store.ts               # SQLite：审计日志 + 待确认队列
  preload/
    gateway-bridge.ts        # contextBridge 暴露给 renderer 的安全 API
  renderer/                  # 你现有的 React Dashboard
```

### 10.2 两条通信路径要分开设计（这是 Electron 架构下对第 3.5 节的修正）

原设计里"确认队列 HTTP API"是假设 Dashboard 和 Gateway 是两个独立进程。在 Electron 项目里情况不同，需要拆成两条路径：

- **Dashboard（React renderer）↔ Gateway**：走 Electron IPC（`ipcMain.handle` / `ipcRenderer.invoke`，经 `contextBridge` 暴露安全 API），不必绕 HTTP。例如 `gateway:confirmations:list`、`gateway:confirmations:approve`、`gateway:skills:run`。
- **Agent（Claude Code / Codex CLI）↔ Gateway**：走 HTTP（MCP over HTTP），因为它们是完全独立的外部 OS 进程，碰不到 Electron 的 IPC 通道，必须用标准协议。

第 3.5 节的 HTTP 确认 API 因此降级为"可选"——只有当你想让确认动作能从手机浏览器之类的外部页面完成时才需要，Dashboard 本身走 IPC 更快也更安全。

### 10.3 单机部署的具体安全设置

- MCP HTTP Server 只绑定 `127.0.0.1`，固定端口（例如 `39217`），**不监听 `0.0.0.0`**，避免局域网内其他设备碰到你的 Gateway
- 用 `app.requestSingleInstanceLock()` 保证同时只有一个 Gateway 实例在监听该端口，避免重复启动冲突
- Gateway 生命周期绑定 Electron 主进程生命周期：`app.whenReady()` 时启动 HTTP server、初始化 SQLite、加载 connector manifest；`before-quit` 时优雅关闭下游连接和数据库连接

### 10.4 凭据存储：Electron `safeStorage`，而不是 `keytar`

- 直接使用 Electron 内置的 `safeStorage` API——它本身就是 OS 原生 keychain 的封装（macOS Keychain / Windows Credential Manager（DPAPI）/ Linux libsecret），不需要再引入第三方的 `keytar`（`keytar` 目前已停止积极维护，Electron 官方文档现在推荐用 `safeStorage` 替代）
- `vault.ts` 对外提供 `setCredential(id, plaintext)` / `getCredential(id)`，内部调用 `safeStorage.encryptString` / `decryptString`；加密后的密文可以直接落盘（存 SQLite 或本地文件），因为解密能力绑定在当前系统用户的登录态上，密文本身泄露也无法在别的机器/账户下解开
- **需要记的技术债**：`safeStorage` 的解密和"这台机器 + 这个系统用户"强绑定，这正好匹配你现在"只考虑单机"的前提；但如果以后要做多机同步（比如接回 Routine L2 的常驻云机器），这套凭据方案不能直接搬过去，需要另外设计凭据同步或云端 Vault 方案——现在不用管，先记下来。
