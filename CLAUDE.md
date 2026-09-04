# CLAUDE.md

本文件是 Claude Code（或其他 agent）在本仓库工作时的项目上下文摘要。详细设计见下方引用的三份文档，本文件只做导航和关键决策的速查，请不要在这里重复展开细节——改了架构决策时，先改对应的详细文档，再回来同步这个摘要。

## 项目是什么

ARMS Agentic OS —— 基于 Applications / Routines / Memory / Skills 四层框架，构建在 Claude（或其他 agent，例如 Codex）之上的个人智能体操作系统。核心理念：日常工作沉淀为 Skill，通过对话 / 面板按钮（headless 执行）/ 定时 Routine 三种方式触发；**Skill 是"大脑"（流程与判断），Application/Connector 是"手"（真正触达外部世界的通道）**，二者是协作关系，不是替代关系——这是对最初"Application 只是附庸"这个想法的修正。

技术形态：一个 Electron + TypeScript + React 桌面应用，自带可视化指挥中心（Dashboard）。已有 MVP：自定义组件看板（Micro Apps / Email / Calendar / Skills Deck / Artifacts / Routines）+ Second Brain 知识库力导向图谱检索（force/circle/hex/rings 布局）。

## 已确定的技术决策

- 运行时/语言：Node.js + TypeScript
- 应用形态：Electron + React，**单机部署**，Gateway 与 Dashboard 同机运行（暂不考虑多机场景）
- 凭据加密：Electron `safeStorage`（封装 OS 原生 keychain：macOS Keychain / Windows Credential Manager / Linux libsecret），不用第三方 `keytar`
- 智能体调用方式：headless 子进程（`claude -p ...` / `codex exec ...`），不把模型能力内嵌进本应用
- Agent ↔ Gateway：标准 **MCP over HTTP**，只监听 `127.0.0.1`（已查证 Claude Code 和 Codex CLI 都支持 MCP-over-HTTP 客户端接入，不需要分别做协议适配器——这是对早期"Codex 可能需要单独协议适配"判断的修正）
- Dashboard(renderer) ↔ 主进程各模块：Electron **IPC**（`contextBridge` 暴露），不走 HTTP；HTTP 只留给外部 Agent 子进程用
- 存储原则：人要编辑、要进版本管理的东西放文件系统（Skill、connector manifest、路由文件）；系统内部状态放 SQLite（运行记录、索引缓存、审批队列）

## 系统分层（详见系统设计文档）

Renderer（Dashboard）→ 主进程 OS Core Services（Skill Registry & Executor / Memory Indexer / Routine Scheduler / Connector Gateway，共享 SQLite + Credential Vault）→ 外部：Agent 子进程（headless CLI）+ 外部 Connector（MCP/API/CLI/浏览器自动化）。

关键设计点：
- Connector Gateway 是所有"高风险动作"的唯一强制拦截点（风险分三档：read-only / write-reversible / write-irreversible，精确到每个 tool，而不是整个 connector 一刀切）
- Routine 靠 Electron 应用"托盘常驻"（关窗口不退出进程）来满足"App 不在前台也要按时触发"的诉求，暂不需要独立云端常驻机器
- Memory Indexer 用 `worker_thread` 做后台增量索引，应对数万文件规模（MVP 已实测到 49925 files / 10075 folders，索引有触顶问题待解决）

## 参考文档（详细设计在这里，不要在本文件重复展开）

- `个人智能体操作系统架构规范_v1.md` —— 使用层规范：Skill 怎么写（SKILL.md 模板、护栏字段、Skill Tree 拆分）、Memory 路由文件怎么建、Routine 可靠性要求、治理与运维节奏、7 天落地路线图
- `ARMS-Agentic-OS-系统设计文档_v1.md` —— 系统总纲：模块边界表、IPC/MCP 接口契约、四个关键数据流场景（Skill 执行 / Routine 触发 / 知识库检索 / 高风险审批）、数据存储总览、进程部署模型、可靠性与安全边界
- `Connector-Gateway-设计文档_v1.md` —— Connector Gateway 模块详细设计：中间件链、协议适配层结论、manifest 格式、Guardrail 风险分级、Electron 落地细节（进程模型、IPC vs HTTP 分工、safeStorage 用法）

## 代码现状

本仓库现在是代码主仓（不再只有文档）。已落地：**Skill Registry & Executor**、**Routine Scheduler**、**托盘常驻的 Electron + React 外壳**（Skills / Routines / Runs / System 四个面板）。目录结构、CLI 用法、配置项见 `README.md`；模块规格见 `docs/superpowers/specs/2026-09-03-skill-registry-executor-design.md`。

注意：隔壁 `E:\Workspace\agentic-os` 是更早的 Electron MVP（Dashboard、Second Brain 图谱、Skills Deck），本仓库只把它当参考，不修改它。将来接 Electron 外壳时，UI 层可以从那边搬。

## 下一步（待办）

1. ~~搭建 Skill Registry & Executor 模块脚手架~~ ✅ 已完成
2. ~~接入 Routine Scheduler 持久化调度~~ ✅ 已完成（croner + 持久化 next_run_at + 托盘常驻；另有 `routines export` 生成系统级定时任务作为 L2 逃生舱）
3. 实现 Connector Gateway 的 MCP HTTP Server + Guardrail 中间件雏形
4. Memory Indexer 增量索引优化，解决"Index hit its file cap"的规模问题
5. 待补：Skill 市场、"我的 Skill"管理界面
