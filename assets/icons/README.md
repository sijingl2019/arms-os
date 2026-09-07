# ARMS 应用图标

标记以四个节点连接一个中央菱形，代表 Applications、Routines、Memory、Skills 汇聚到智能体核心。

- `app-icon.png`：透明背景的 Liquid Glass 主图标原稿，用于应用窗口和 macOS Dock。
- `app-icon.ico`：Windows 任务栏图标，包含 16–256 px 的 9 个尺寸。
- `tray.svg`：同一标记的简化矢量源稿，去掉玻璃底座，适配小尺寸。
- `tray-dark.*`：深色图形，用于浅色任务栏；`tray-light.*`：白色图形，用于深色任务栏。

Electron 的 `?asset` 导入会把实际使用的图标复制到构建输出。Windows 托盘根据系统任务栏主题切换，与应用内部主题独立；macOS 使用 template image。

重新导出：`python scripts/export-icons.py`（需要 Pillow、Playwright 和 Chromium）。原稿不覆盖，导出只生成 ICO 和托盘 PNG。原生加载检查：`node_modules/.bin/electron scripts/check-icons.cjs`。
