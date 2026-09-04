import { ipcMain, type BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type {
  RoutineInput,
  RunHistoryQuery,
  SkillRunRequest,
  SystemStatus,
  SystemTaskExport
} from '@shared/types'
import type { ArmsCore } from '../core'
import { planSystemTask } from '../routines/systemTask'
import { writeSkillsIndex } from '../skills/indexFile'

export interface IpcDeps {
  core: ArmsCore
  /** Live windows to broadcast events to. */
  windows(): BrowserWindow[]
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
    core.bus.on('gateway:tool:called', (e) => broadcast(CH.eventToolCalled, e))
  ]

  const channels = [
    CH.skillsList,
    CH.skillsGet,
    CH.skillsRefresh,
    CH.skillsWriteIndex,
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
    CH.confirmationsReject
  ]

  return () => {
    for (const off of unsubscribes) off()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
