import { ipcMain, shell, type BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type {
  MemoryIndexResult,
  NewSkillRequest,
  MemorySearchQuery,
  RoutineInput,
  RunHistoryQuery,
  SkillRunRequest,
  SystemStatus,
  SystemTaskExport
} from '@shared/types'
import type { ArmsCore } from '../core'
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

  ipcMain.handle(CH.systemStatus, () => buildStatus(core))

  ipcMain.handle(CH.gatewayStatus, () => core.gatewayStatus())
  ipcMain.handle(CH.gatewayReload, () => core.gateway.reload())
  ipcMain.handle(CH.gatewayToolCalls, (_e, limit?: number) =>
    core.db
      .prepare('SELECT * FROM tool_calls ORDER BY started_at DESC LIMIT ?')
      .all(limit ?? 100)
  )

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
    CH.systemStatus,
    CH.gatewayStatus,
    CH.gatewayReload,
    CH.gatewayToolCalls,
    CH.confirmationsPending,
    CH.confirmationsHistory,
    CH.confirmationsApprove,
    CH.confirmationsReject,
    CH.memorySearch,
    CH.memoryStatus,
    CH.memoryRefresh,
    CH.memoryWriteRouter
  ]

  return () => {
    for (const off of unsubscribes) off()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
