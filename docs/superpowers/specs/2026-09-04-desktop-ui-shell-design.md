# 桌面式 UI 外壳设计（Desktop Shell）

- 日期：2026-09-04
- 状态：已确认，待实现
- 影响模块：Electron 主进程窗口/菜单、preload 桥、renderer 全部

## 1. 目标

把现在「原生标题栏 + 顶部 tab 栏 + 六个面板」的 Dashboard，改造成一个**桌面隐喻**的首页：

1. 去掉 Electron 原生标题栏与默认菜单栏，改为无边框窗口 + 自绘窗口控件。
2. 首页是一块桌面：左右各三个常驻控件，正中间是带粒子效果的「头脑风暴」动画，点击后浮出知识库搜索。
3. 现有六个面板（Skills / Routines / Runs / Memory / Gateway / System）改成底部 Mac 风格 Dock 上的图标入口；部分桌面控件的右上角也提供一个直达对应面板的入口。

非目标（本轮明确不做）：接入真实日历/邮件后端；把面板做成可拖拽的多窗口；引入 3D 引擎；引入前端组件测试栈。

## 2. 已确认的四个决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| Apps/Calendar/Git/Email 四个控件的数据 | Apps → 已有的 Gateway connector 列表；Git → 新增只读 IPC；Calendar/Email → 明写「未接入」的静态占位 | 只展示真实数据，不用假数据把空壳伪装成功能 |
| 面板呈现方式 | 全屏 overlay 覆盖桌面，桌面在底下模糊压暗 | 视觉上仍是 OS，但不需要实现窗口栈/拖拽/聚焦 |
| 中央大脑 | 手写 Canvas 2D 粒子 | 零新依赖，可控可省电；这是常驻托盘的应用，不适合长期占 GPU |
| 无边框后的窗口控件 | `frame: false` + 自绘三按钮 | Windows 上 `titleBarOverlay` 会在右上角留一块系统色块，破坏桌面观感 |

## 3. 主进程改动

### 3.1 窗口与菜单（`src/main/index.ts`）

- `new BrowserWindow({ frame: false, ... })`，其余安全基线（`contextIsolation`、`sandbox`、无 `nodeIntegration`）不变。
- `Menu.setApplicationMenu(null)` 移除默认应用菜单。副作用是 DevTools 的 F12/Ctrl+Shift+I 加速键随之失效，因此在 `ELECTRON_RENDERER_URL` 存在（即 dev）时，通过 `win.webContents.on('before-input-event')` 单独把 F12 绑回 `toggleDevTools`。
- 托盘菜单保持不变；托盘常驻语义不受影响。

### 3.2 窗口控制 IPC

新增通道（`src/shared/channels.ts`）：

| 通道 | 语义 |
|---|---|
| `window:minimize` | `win.minimize()` |
| `window:maximize` | 已最大化则 `unmaximize()`，否则 `maximize()`；返回新的最大化状态 |
| `window:close` | **走现有的隐藏到托盘语义**（`win.close()` 被 `close` 事件拦成 `hide()`），不是退出进程 |
| `event:window-maximized`（main → renderer） | 在 `maximize` / `unmaximize` 事件上广播布尔值 |

「关闭按钮 = 隐藏到托盘」这条必须保留：托盘常驻是 Routine L1 可靠性的前提（系统设计文档 §6.2），换一个自绘按钮不能改变它。退出仍然只有托盘菜单一条路径。

`window:maximized` 事件的存在是因为用户可以用系统手势（双击拖拽条、Win+↑、贴边）改变最大化状态，自绘按钮的图标必须跟着翻转，不能只依赖自己那次点击。

### 3.3 Git 只读 IPC

新增 `git:status`，在 `core.config.workspaceRoot` 下执行两条只读命令：

- `git status --porcelain=v2 --branch`
- `git log -5 --pretty=format:%h%x09%an%x09%ad%x09%s --date=short`

返回类型（放进 `@shared/types`）：

```ts
export interface GitCommit { hash: string; author: string; date: string; subject: string }
export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  commits: GitCommit[]
  error: string | null
}
```

约束：

- 只读。不提供任何写操作（无 commit / checkout / pull），因此不经过 Gateway 的 Guardrail —— Guardrail 拦的是 agent 发起的外部动作，这里是 Dashboard 读自身工作区。
- 命令执行超时 5s；非仓库、`git` 不在 PATH、超时都收敛成 `{ isRepo: false, error }`，不抛异常。
- `--porcelain=v2` 的输出解析拆成纯函数 `parseGitStatusV2(stdout)`，单独单测。

### 3.4 打开知识库文件

新增 `memory:open`，参数是 `MemorySearchHit.path`，实现为 `shell.openPath(path)`，返回失败字符串或空串。用于中央搜索结果的点击。

安全边界：路径必须落在已索引的 memory roots 之内才放行，否则拒绝。renderer 传进来的路径不能无条件交给 `openPath`。

## 4. Renderer 结构

```
src/renderer/src/
  App.tsx                     外壳：Desktop + OverlayHost + Dock + WindowControls
  routes.ts                   PanelId 联合类型 + Dock 图标/标题元数据
  desktop/
    Desktop.tsx               三栏栅格布局
    WindowControls.tsx        右上角自绘三按钮
    DragStrip.tsx             顶部 40px 拖拽条（-webkit-app-region: drag）
    Dock.tsx                  底部居中毛玻璃 Dock
    SearchOverlay.tsx         点大脑后的知识库搜索
    OverlayHost.tsx           面板全屏覆盖层 + ErrorBoundary
    brain/
      BrainCanvas.tsx         单 canvas、单 rAF
      points.ts               SVG 路径 → 点云（纯函数）
      field.ts                轨道粒子一步演化（纯函数）
      brainPath.ts            内置大脑轮廓 SVG 路径常量
    widgets/
      WidgetFrame.tsx         统一卡片外壳
      AppsWidget.tsx  CalendarWidget.tsx  GitWidget.tsx
      EmailWidget.tsx SkillsWidget.tsx    RoutinesWidget.tsx
  panels/                     六个面板原样保留
  theme.css                   保留变量与面板样式
  desktop.css                 桌面/Dock/控件/大脑的新样式
```

### 4.1 路由

`App` 持有 `route: PanelId | null`。`null` 表示桌面。

- Dock 图标点击 → 设为对应 `PanelId`；点击当前已激活的图标 → 设回 `null`。
- Esc → 设回 `null`。
- overlay 左上角返回按钮 → 设回 `null`。

不引入路由库，也不写进 URL：这是一个单窗口桌面应用，没有前进后退和深链需求。

### 4.2 桌面布局

CSS Grid 三栏：`minmax(240px, 300px) 1fr minmax(240px, 300px)`，左右列各三个控件纵向排列，中间列放大脑。窗口宽度低于 1100px 时，左右列收窄；低于 900px（已是 `minWidth`）时控件字号降一级。顶部留出 40px 拖拽条，底部留出 Dock 高度。

### 4.3 六个控件

| 位置 | 控件 | 数据源 | 右上角「打开」 |
|---|---|---|---|
| 左 1 | Apps | `gateway.status().connectors`：名称 / transport / tool 数 / 错误 | → Gateway |
| 左 2 | Calendar | 无。静态占位，正文写「未接入」 | 无 |
| 左 3 | Git | `git:status` | 无（没有对应面板） |
| 右 1 | Email | 无。静态占位，正文写「未接入」 | 无 |
| 右 2 | Skills | `skills.list()` 计数 + `skills.lint()` 健康计数 | → Skills |
| 右 3 | Routines | `routines.list()`：启用数 + 最近的 `nextRunAt` | → Routines |

`WidgetFrame` 只在传入 `openPanel` 时才渲染右上角按钮，占位控件因此天然没有入口。

刷新：控件挂载时拉一次，并订阅与自己相关的事件（Skills 订 `skillsIndexed`、Routines 订 `routinesUpdated`、Apps 订 `toolCalled`）。Git 没有事件源，改为窗口获得焦点时重新拉取。

### 4.4 Dock

底部居中，`backdrop-filter: blur(20px)` + 半透明底色 + 1px 高光描边。六个图标（Skills / Routines / Runs / Memory / Gateway / System），左端另有一个 Home 图标用于显式回到桌面。hover 时图标放大并浮出名称气泡，当前激活项下方有一个小圆点。Gateway 图标在有待审批时挂角标——这条是从现有 topbar 的 badge 迁移过来的，不能丢。

图标一律用内联 SVG，不引图标库：CSP 是 `script-src 'self'`，且不值得为六个图标加依赖。

## 5. 粒子大脑

一个 `<canvas>`、一条 `requestAnimationFrame` 循环，自底向上画三层：

1. **球体辉光**：径向渐变实现包裹球，叠两三条倾斜椭圆弧作经纬线。
2. **大脑点云**：`brainPath.ts` 里的 SVG 路径（外轮廓 + 若干脑沟曲线 + 小脑与脑干）用 `Path2D` 光栅化后采样出约 1200 个点。每个点由确定性 hash 得到一个伪 z 值，整体绕 y 轴慢速旋转并做弱透视投影产生视差；亮度 = 每点独立相位的正弦闪烁 × 深度衰减，其中约 5% 的点额外绘制十字星芒 —— 这是需求里「类似星星带闪烁效果」。
3. **外围流动粒子**：若干条倾斜椭圆轨道，每条上分布若干粒子，按各自角速度漂移，并绘制一小段拖尾线 —— 这是需求里「外围粒子要有流动效果」。

工程约束：

- DPR 自适应；`ResizeObserver` 处理尺寸变化，重算点云。
- 省电：`document.hidden`、窗口 blur、或 overlay 打开时停 rAF（大脑此时不可见）。
- `prefers-reduced-motion: reduce` 时只渲染一帧静态图，不启动循环。
- 点云采样与轨道演化拆成 `points.ts` / `field.ts` 两个纯函数模块，`BrainCanvas.tsx` 只负责 canvas 生命周期与绘制。

## 6. 中央搜索

点击大脑 → `SearchOverlay` 在中央浮出（大脑降亮度作背景）。

- 输入 debounce 200ms 后调 `memory.search({ query, limit: 20 })`。
- 结果渲染 `title` / `relPath` / `snippet`；点击调 `memory.open(path)`。
- 空查询不发请求；无结果显示空状态；`memory.status()` 显示索引是否为空并提示去 Memory 面板做一次 refresh。
- Esc 或点击遮罩关闭。

## 7. 错误处理

- 每个控件自管 `loading` / `error`，出错渲染一行灰字（含原因），不向上抛。
- `OverlayHost` 外包一层 ErrorBoundary：某个面板渲染崩溃只影响 overlay，桌面与 Dock 仍可用，并提供「返回桌面」。
- 主进程新增的三类 IPC（window / git / memory:open）全部返回结果而非抛异常穿过 IPC 边界。

## 8. 测试

用现有 vitest：

- `parseGitStatusV2`：分支行、ahead/behind、staged/unstaged/untracked 计数、非仓库输出。
- `points.ts`：给定路径与尺寸，采样点数量落在期望区间、全部落在包围盒内、同种子两次采样结果一致。
- `field.ts`：一步演化后粒子仍在轨道上、角度正确回绕、拖尾长度有界。

已知缺口（明确不在本轮）：仓库当前没有 jsdom / Testing Library，因此 React 组件、Dock 交互、overlay 路由没有自动化测试，只做人工验证。为这次 UI 改造引入并调通一整套前端测试栈超出本轮范围，留作技术债记录在 README。

## 9. 验收清单

1. 启动后窗口没有原生标题栏，也没有菜单栏。
2. 右上角三个自绘按钮可用；用系统手势最大化后按钮图标同步翻转；点关闭是隐藏到托盘，托盘图标仍在，Routine 仍会触发。
3. 顶部拖拽条可以拖动窗口，双击可最大化；条上的交互元素不被拖拽吞掉。
4. 桌面左列自上而下是 Apps / Calendar / Git，右列是 Email / Skills / Routines。
5. Apps 显示真实 connector；Git 显示真实分支与提交；Skills / Routines 显示真实计数；Calendar / Email 明写未接入。
6. 中央大脑有旋转点云、闪烁星点与外围流动粒子；窗口失焦后 CPU 占用回落。
7. 点击大脑浮出搜索框，能搜到知识库内容并打开文件。
8. Dock 六个图标可进入对应面板；Gateway 待审批角标仍在；Esc 与 Home 图标可回桌面。
9. `npm run typecheck` 与 `npm test` 通过。
