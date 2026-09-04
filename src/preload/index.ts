import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/channels'
import type {
  ArmsOsBridge,
  RoutineInput,
  RunHistoryQuery,
  SkillRunRequest
} from '@shared/types'

/**
 * Wrap an `ipcRenderer.on` subscription so callers get an unsubscribe function
 * and never have to hold the listener reference themselves.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const bridge: ArmsOsBridge = {
  skills: {
    list: () => ipcRenderer.invoke(CH.skillsList),
    get: (id: string) => ipcRenderer.invoke(CH.skillsGet, id),
    refresh: () => ipcRenderer.invoke(CH.skillsRefresh),
    writeIndex: () => ipcRenderer.invoke(CH.skillsWriteIndex),
    run: (req: SkillRunRequest) => ipcRenderer.invoke(CH.skillRun, req),
    cancel: (runId: string) => ipcRenderer.invoke(CH.skillCancel, runId)
  },
  runs: {
    history: (query?: RunHistoryQuery) => ipcRenderer.invoke(CH.runsHistory, query)
  },
  routines: {
    list: () => ipcRenderer.invoke(CH.routinesList),
    create: (input: RoutineInput) => ipcRenderer.invoke(CH.routinesCreate, input),
    update: (id: string, patch: Partial<RoutineInput>) =>
      ipcRenderer.invoke(CH.routinesUpdate, id, patch),
    remove: (id: string) => ipcRenderer.invoke(CH.routinesRemove, id),
    exportSystemTask: (id: string) => ipcRenderer.invoke(CH.routinesExport, id)
  },
  system: {
    status: () => ipcRenderer.invoke(CH.systemStatus)
  },
  on: {
    runStarted: (cb) => subscribe(CH.eventRunStarted, cb),
    runChunk: (cb) => subscribe(CH.eventRunChunk, cb),
    runCompleted: (cb) => subscribe(CH.eventRunCompleted, cb),
    skillsIndexed: (cb) => subscribe(CH.eventSkillsIndexed, cb),
    routinesUpdated: (cb) => subscribe(CH.eventRoutinesUpdated, cb)
  }
}

// contextIsolation is on, so this is the renderer's only route into the main
// process. Nothing else is exposed - no `require`, no raw ipcRenderer.
contextBridge.exposeInMainWorld('arms', bridge)
