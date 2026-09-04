import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron'
import { CH } from '@shared/channels'
import { loadConfig } from './config'
import { createCore, type ArmsCore } from './core'
import { createElectronVault } from './gateway/electronVault'
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
/** Mirrored into the tray tooltip so a waiting approval is visible when hidden. */
let pendingApprovals = 0

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
    // The desktop shell draws its own title bar and window buttons; a native
    // frame would sit on top of the wallpaper and break the metaphor.
    frame: false,
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

  // The desktop metaphor only works at full size: the six widgets and the
  // brain need the room. The width/height above stay as the restore size.
  win.maximize()

  win.once('ready-to-show', () => win.show())

  // The user can also maximize with a system gesture (double-click on the drag
  // strip, Win+Up, edge snap), so the renderer's button has to follow the
  // window rather than its own last click.
  const sendMaximized = (maximized: boolean): void => {
    if (!win.isDestroyed()) win.webContents.send(CH.eventWindowMaximized, maximized)
  }
  win.on('maximize', () => sendMaximized(true))
  win.on('unmaximize', () => sendMaximized(false))
  // The window is maximized before the renderer exists, so it would otherwise
  // miss that first event and draw the wrong button.
  win.webContents.on('did-finish-load', () => sendMaximized(win.isMaximized()))

  // Removing the application menu also removes its DevTools accelerator, so in
  // development put F12 back explicitly.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
  }

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

function refreshTray(): void {
  if (!tray) return
  tray.setToolTip(
    pendingApprovals > 0
      ? `ARMS Agentic OS - ${pendingApprovals} action(s) awaiting approval`
      : 'ARMS Agentic OS'
  )
}

function buildTray(): Tray {
  const t = new Tray(trayIcon())
  t.setToolTip('ARMS Agentic OS')
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showWindow },
      { type: 'separator' },
      {
        label: 'Reload connectors',
        click: () => {
          void core?.gateway.reload()
        }
      },
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
  // No native menu bar: the Dock and the tray are the only chrome this app has.
  Menu.setApplicationMenu(null)

  // safeStorage only exists here, in the main process; the CLI deliberately
  // gets a vault that refuses rather than a weaker fallback.
  const config = loadConfig()
  core = createCore({ vault: createElectronVault(config.stateDir) })
  teardownIpc = registerIpc({
    core,
    windows: () => BrowserWindow.getAllWindows()
  })

  // Index before scheduling, so the scheduler's "does this skill exist" check
  // sees a populated registry on the very first tick.
  await core.registry.refresh()
  core.startScheduler()

  try {
    const gateway = await core.startGateway()
    console.log(`[gateway] listening on ${gateway.endpoint}`)
    for (const issue of gateway.issues) console.warn(`[gateway] ${issue}`)
  } catch (err) {
    // A blocked port must not take the whole app down: skills and routines
    // still work without an MCP endpoint.
    console.error(`[gateway] not started: ${(err as Error).message}`)
  }

  // A pending approval is the one thing worth surfacing while hidden - the
  // agent is blocked until someone answers.
  core.bus.on('gateway:confirmation:pending', () => {
    pendingApprovals += 1
    refreshTray()
    showWindow()
  })
  core.bus.on('gateway:confirmation:decided', () => {
    pendingApprovals = Math.max(0, pendingApprovals - 1)
    refreshTray()
  })

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
  void core?.close()
  tray?.destroy()
  core = undefined
  tray = undefined
})
