import { stat } from 'node:fs/promises'
import path from 'node:path'
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type {
  ChatAttachment,
  MemoryIndexResult,
  NewSkillRequest,
  MemorySearchQuery,
  RoutineInput,
  RunHistoryQuery,
  SkillRunRequest,
  SystemStatus,
  SystemTaskExport
} from '@shared/types'
import { probeAgents } from '../agents/probe'
import { createChatSession } from '../chat'
import type { ArmsCore } from '../core'
import { readGitStatus } from '../git/status'
import { writeRouterFiles } from '../memory/router'
import { planSystemTask } from '../routines/systemTask'
import { writeSkillsIndex } from '../skills/indexFile'
import { lintSkills } from '../skills/lint'
import { createSkill } from '../skills/scaffold'

export interface IpcDeps {
  core: ArmsCore
  /** Live windows to broadcast events to. */
  windows(): BrowserWindow[]
}

/** New skills belong in the workspace root, never in the shared user library. */
function workspaceSkillsDir(core: ArmsCore): string {
  const workspace = core.config.scanRoots.find((r) => r.source === 'workspace')
  return workspace?.dir ?? core.config.scanRoots[0]?.dir ?? core.config.workspaceRoot
}

/**
 * True when `target` sits inside `root`. The renderer supplies the path it got
 * back from a search hit, but a compromised renderer could supply anything, so
 * `memory:open` will only hand the OS a file we actually indexed.
 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function buildStatus(core: ArmsCore): SystemStatus {
  const routines = core.routines.list()
  const nextTriggerAt =
    routines
      .map((r) => r.nextRunAt)
      .filter((v): v is string => v !== null)
      .sort()[0] ?? null

  return {
    workspaceRoot: core.config.workspaceRoot,
    stateDir: core.config.stateDir,
    dbPath: core.config.dbPath,
    runLogPath: core.config.runLogPath,
    defaultAgent: core.config.defaultAgent,
    scanRoots: core.config.scanRoots.map((r) => ({ dir: r.dir, source: r.source })),
    skillCount: core.registry.list().length,
    routineCount: routines.length,
    nextTriggerAt,
    interruptedRuns: core.interrupted,
    scheduler: core.schedulerReport
  }
}

/**
 * Bind the renderer-facing API and forward bus events over IPC.
 *
 * Returns a teardown that removes every handler and unsubscribes from the bus,
 * so a reload cannot end up with two sets of listeners.
 */
export function registerIpc({ core, windows }: IpcDeps): () => void {
  const windowOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined =>
    windows().find((win) => !win.isDestroyed() && win.webContents.id === event.sender.id)

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of windows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  ipcMain.handle(CH.skillsList, () => core.registry.list())
  ipcMain.handle(CH.skillsGet, (_e, id: string) => core.registry.get(id) ?? null)
  ipcMain.handle(CH.skillsRefresh, () => core.registry.refresh())
  ipcMain.handle(CH.skillsWriteIndex, async () => {
    await writeSkillsIndex(core.config.skillsIndexPath, core.registry.list())
    return core.config.skillsIndexPath
  })

  ipcMain.handle(CH.skillsLint, () =>
    lintSkills({
      skills: core.registry.list(),
      tools: core.gateway.registry.tools().map((t) => ({ connectorId: t.connectorId, risk: t.risk }))
    })
  )
  ipcMain.handle(CH.skillsCreate, async (_e, req: NewSkillRequest) => {
    const created = await createSkill(req, workspaceSkillsDir(core))
    // Index it immediately so the deck shows it without a manual rescan.
    await core.registry.refresh()
    return created
  })
  ipcMain.handle(CH.skillsReveal, (_e, id: string) => {
    const skill = core.registry.get(id)
    if (!skill) return false
    shell.showItemInFolder(skill.path)
    return true
  })

  ipcMain.handle(CH.skillRun, (_e, req: SkillRunRequest) =>
    core.executor.run({ ...req, trigger: req.trigger ?? 'dashboard' })
  )
  ipcMain.handle(CH.skillCancel, (_e, runId: string) => core.executor.cancel(runId))
  ipcMain.handle(CH.runsHistory, (_e, query?: RunHistoryQuery) =>
    core.executor.history(query ?? {})
  )

  ipcMain.handle(CH.routinesList, () => core.routines.list())
  ipcMain.handle(CH.routinesCreate, (_e, input: RoutineInput) => core.routines.create(input))
  ipcMain.handle(CH.routinesUpdate, (_e, id: string, patch: Partial<RoutineInput>) =>
    core.routines.update(id, patch)
  )
  ipcMain.handle(CH.routinesRemove, (_e, id: string) => core.routines.remove(id))
  ipcMain.handle(CH.routinesExport, (_e, id: string): SystemTaskExport => {
    const routine = core.routines.get(id)
    if (!routine) throw new Error(`unknown routine: ${id}`)
    return planSystemTask({ routine, workspaceRoot: core.config.workspaceRoot })
  })

  ipcMain.handle(CH.routinesResult, (_e, id: string) => core.routines.result(id) ?? null)

  ipcMain.handle(CH.systemStatus, () => buildStatus(core))

  ipcMain.handle(CH.gatewayStatus, () => core.gatewayStatus())
  ipcMain.handle(CH.gatewayReload, () => core.gateway.reload())
  ipcMain.handle(CH.gatewayToolCalls, (_e, limit?: number) => core.gateway.recentCalls(limit))
  ipcMain.handle(CH.gatewayPrune, () => {
    const { aged, noise, total } = core.gateway.prune()
    return { aged, noise, total }
  })
  ipcMain.handle(CH.gatewayCompact, () => core.gateway.compact())

  // Ids only. A handler that returned a secret would put it in the renderer,
  // where any XSS or a devtools console could read it back out.
  ipcMain.handle(CH.vaultList, () => core.gateway.vault.list())
  ipcMain.handle(CH.vaultSet, async (_e, id: string, secret: string) => {
    await core.gateway.vault.set(id, secret)
  })
  ipcMain.handle(CH.vaultRemove, (_e, id: string) => core.gateway.vault.remove(id))

  ipcMain.handle(CH.memorySearch, (_e, query: MemorySearchQuery) => core.indexer.search(query))
  ipcMain.handle(CH.memoryStatus, () => core.indexer.status())
  ipcMain.handle(
    CH.memoryRefresh,
    (_e, opts?: { force?: boolean; writeRouter?: boolean }): Promise<MemoryIndexResult> =>
      core.indexer.refresh(opts ?? {})
  )
  ipcMain.handle(CH.memoryWriteRouter, async (_e, dryRun?: boolean) => {
    if (!core.config.memoryRouterRoot) throw new Error('no memory router root is configured')
    return writeRouterFiles({
      store: core.memory,
      routerRoot: core.config.memoryRouterRoot,
      ...(dryRun ? { dryRun: true } : {})
    })
  })

  ipcMain.handle(CH.memoryOpen, async (_e, target: string) => {
    if (typeof target !== 'string' || target === '') return 'no path given'
    if (!core.config.memoryRoots.some((root) => isInside(root, target))) {
      return 'path is outside the indexed knowledge base'
    }
    return shell.openPath(target)
  })

  ipcMain.handle(CH.agentsList, () => probeAgents(core.config.defaultAgent))

  // One conversation per app session, owned here rather than by the renderer so
  // the prompt sent to the CLI is built from a single transcript.
  const chat = createChatSession({
    config: core.config,
    onChunk: (messageId, chunk) => broadcast(CH.eventChatChunk, { messageId, chunk }),
    onCompleted: (message) => broadcast(CH.eventChatCompleted, message)
  })

  ipcMain.handle(CH.chatHistory, () => chat.history())
  ipcMain.handle(CH.chatSend, (_e, text: string, attachments?: ChatAttachment[]) =>
    chat.send(String(text ?? ''), Array.isArray(attachments) ? attachments : [])
  )

  ipcMain.handle(CH.chatPickFiles, async (event): Promise<ChatAttachment[]> => {
    const win = windowOf(event)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
      : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []

    return Promise.all(
      result.filePaths.map(async (file) => ({
        path: file,
        name: path.basename(file),
        // A file that vanished between the picker and here is not worth an
        // error; the agent will report it when it tries to read it.
        size: await stat(file)
          .then((s) => s.size)
          .catch(() => 0)
      }))
    )
  })
  ipcMain.handle(CH.chatCancel, () => chat.cancel())
  ipcMain.handle(CH.chatClear, () => chat.clear())

  ipcMain.handle(CH.gitStatus, () => readGitStatus(core.config.workspaceRoot))

  // Frameless windows have no native buttons; these are the replacements.
  ipcMain.handle(CH.windowMinimize, (event) => {
    windowOf(event)?.minimize()
  })
  ipcMain.handle(CH.windowMaximize, (event) => {
    const win = windowOf(event)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle(CH.windowClose, (event) => {
    // `close` is intercepted in main/index.ts and turned into `hide`, which is
    // what keeps the Routine Scheduler alive. Quitting stays tray-menu-only.
    windowOf(event)?.close()
  })

  ipcMain.handle(CH.memoryChooseRoot, async (): Promise<string | null> => {
    const [parent] = windows()
    const result = await dialog.showOpenDialog(
      // Modal to the window when there is one, so the picker cannot be lost
      // behind the app.
      parent && !parent.isDestroyed() ? parent : ({} as BrowserWindow),
      {
        title: '选择知识库文件夹',
        properties: ['openDirectory', 'createDirectory']
      }
    )
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(CH.memorySetRoots, (_e, roots: string[]) => core.setMemoryRoots(roots))

  ipcMain.handle(CH.confirmationsPending, () => core.gateway.confirmations.listPending())
  ipcMain.handle(CH.confirmationsHistory, (_e, limit?: number) =>
    core.gateway.confirmations.history(limit ?? 50)
  )
  ipcMain.handle(CH.confirmationsApprove, (_e, id: string) =>
    core.gateway.confirmations.approve(id)
  )
  ipcMain.handle(CH.confirmationsReject, (_e, id: string, reason: string) =>
    core.gateway.confirmations.reject(id, reason)
  )

  const unsubscribes = [
    core.bus.on('skill:run:started', (e) => broadcast(CH.eventRunStarted, e)),
    core.bus.on('skill:run:chunk', (e) => broadcast(CH.eventRunChunk, e)),
    core.bus.on('skill:run:completed', (e) => broadcast(CH.eventRunCompleted, e)),
    core.bus.on('skills:index:updated', (e) => broadcast(CH.eventSkillsIndexed, e)),
    core.bus.on('routines:updated', (e) => broadcast(CH.eventRoutinesUpdated, e)),
    core.bus.on('gateway:confirmation:pending', (e) =>
      broadcast(CH.eventConfirmationPending, e)
    ),
    core.bus.on('gateway:confirmation:decided', (e) =>
      broadcast(CH.eventConfirmationDecided, e)
    ),
    core.bus.on('gateway:tool:called', (e) => broadcast(CH.eventToolCalled, e)),
    core.bus.on('memory:index:progress', (e) => broadcast(CH.eventMemoryProgress, e)),
    core.bus.on('memory:index:completed', (e) => broadcast(CH.eventMemoryCompleted, e))
  ]

  const channels = [
    CH.skillsList,
    CH.skillsGet,
    CH.skillsRefresh,
    CH.skillsWriteIndex,
    CH.skillsLint,
    CH.skillsCreate,
    CH.skillsReveal,
    CH.skillRun,
    CH.skillCancel,
    CH.runsHistory,
    CH.routinesList,
    CH.routinesCreate,
    CH.routinesUpdate,
    CH.routinesRemove,
    CH.routinesExport,
    CH.routinesResult,
    CH.systemStatus,
    CH.gatewayStatus,
    CH.gatewayReload,
    CH.gatewayToolCalls,
    CH.gatewayPrune,
    CH.gatewayCompact,
    CH.vaultList,
    CH.vaultSet,
    CH.vaultRemove,
    CH.confirmationsPending,
    CH.confirmationsHistory,
    CH.confirmationsApprove,
    CH.confirmationsReject,
    CH.memorySearch,
    CH.memoryStatus,
    CH.memoryRefresh,
    CH.memoryWriteRouter,
    CH.memoryOpen,
    CH.agentsList,
    CH.chatHistory,
    CH.chatSend,
    CH.chatPickFiles,
    CH.chatCancel,
    CH.chatClear,
    CH.gitStatus,
    CH.windowMinimize,
    CH.windowMaximize,
    CH.windowClose
  ]

  return () => {
    // A chat still streaming would otherwise outlive the window it feeds.
    chat.cancel()

    for (const off of unsubscribes) off()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
