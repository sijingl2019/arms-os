import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron'
import { createCore, type ArmsCore } from './core'
import { registerIpc } from './ipc/register'

/**
 * Electron entry point. Everything the OS Core Services need is built once in
 * `app.whenReady` and torn down in `before-quit` (系统设计文档 §8).
 *
 * The window is a view onto the core, not its owner: closing it hides the app
 * to the tray and leaves the Routine Scheduler ticking, which is the whole
 * premise of Routine L1 (系统设计文档 §6.2).
 */

let core: ArmsCore | undefined
let teardownIpc: (() => void) | undefined
let tray: Tray | undefined
let mainWindow: BrowserWindow | undefined
/** Set on `before-quit` so a close during shutdown is not treated as hide. */
let quitting = false

// A second instance would bind a second scheduler to the same database and
// double-fire every routine.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1116',
    title: 'ARMS Agentic OS',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Electron security baseline (系统设计文档 §10): the renderer gets no
      // Node, and reaches the main process only through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  win.on('close', (event) => {
    if (quitting) return
    // Keep the process (and the scheduler) alive in the tray.
    event.preventDefault()
    win.hide()
  })

  // External links belong in the user's browser, never in an app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * A 1x1 transparent image is a deliberate placeholder: Tray requires an image,
 * and shipping a real icon is a design task, not a wiring one.
 */
function trayIcon(): Electron.NativeImage {
  const image = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVR42mNkoBAwjhow' +
      'asCoAaMGjBowasCoAaMGjBowasCoAaMGjBowasCoAaMGjBowasCoAaMGDDwDAAzUAAF3AWpjAAAAAElFTkSuQmCC'
  )
  return image.isEmpty() ? nativeImage.createEmpty() : image
}

function buildTray(): Tray {
  const t = new Tray(trayIcon())
  t.setToolTip('ARMS Agentic OS')
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showWindow },
      { type: 'separator' },
      {
        label: 'Rescan skills',
        click: () => {
          void core?.registry.refresh()
        }
      },
      {
        label: 'Run scheduler now',
        click: () => {
          core?.scheduler.tick()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit ARMS',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  t.on('double-click', showWindow)
  return t
}

app.on('second-instance', showWindow)

void app.whenReady().then(async () => {
  core = createCore()
  teardownIpc = registerIpc({
    core,
    windows: () => BrowserWindow.getAllWindows()
  })

  // Index before scheduling, so the scheduler's "does this skill exist" check
  // sees a populated registry on the very first tick.
  await core.registry.refresh()
  core.startScheduler()

  tray = buildTray()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    else showWindow()
  })
})

// Tray residency: on every platform, a closed window means hidden, not exited.
app.on('window-all-closed', () => {
  /* intentionally empty - quitting happens through the tray menu */
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  teardownIpc?.()
  core?.close()
  tray?.destroy()
  core = undefined
  tray = undefined
})
