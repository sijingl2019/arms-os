import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH } from '@shared/channels'
import type {
  ArmsOsBridge,
  ChatAttachment,
  MemorySearchQuery,
  NewSkillRequest,
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
    cancel: (runId: string) => ipcRenderer.invoke(CH.skillCancel, runId),
    lint: () => ipcRenderer.invoke(CH.skillsLint),
    create: (req: NewSkillRequest) => ipcRenderer.invoke(CH.skillsCreate, req),
    reveal: (id: string) => ipcRenderer.invoke(CH.skillsReveal, id)
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
    exportSystemTask: (id: string) => ipcRenderer.invoke(CH.routinesExport, id),
    result: (id: string) => ipcRenderer.invoke(CH.routinesResult, id)
  },
  system: {
    status: () => ipcRenderer.invoke(CH.systemStatus)
  },
  gateway: {
    status: () => ipcRenderer.invoke(CH.gatewayStatus),
    reload: () => ipcRenderer.invoke(CH.gatewayReload),
    toolCalls: (limit?: number) => ipcRenderer.invoke(CH.gatewayToolCalls, limit),
    prune: () => ipcRenderer.invoke(CH.gatewayPrune),
    compact: () => ipcRenderer.invoke(CH.gatewayCompact)
  },
  memory: {
    search: (query: MemorySearchQuery) => ipcRenderer.invoke(CH.memorySearch, query),
    status: () => ipcRenderer.invoke(CH.memoryStatus),
    refresh: (opts?: { force?: boolean; writeRouter?: boolean }) =>
      ipcRenderer.invoke(CH.memoryRefresh, opts),
    writeRouter: (dryRun?: boolean) => ipcRenderer.invoke(CH.memoryWriteRouter, dryRun),
    open: (path: string) => ipcRenderer.invoke(CH.memoryOpen, path),
    chooseRoot: () => ipcRenderer.invoke(CH.memoryChooseRoot),
    setRoots: (roots: string[]) => ipcRenderer.invoke(CH.memorySetRoots, roots)
  },
  agents: {
    list: () => ipcRenderer.invoke(CH.agentsList)
  },
  chat: {
    history: () => ipcRenderer.invoke(CH.chatHistory),
    send: (text: string, attachments?: ChatAttachment[]) =>
      ipcRenderer.invoke(CH.chatSend, text, attachments),
    pickFiles: () => ipcRenderer.invoke(CH.chatPickFiles),
    cancel: () => ipcRenderer.invoke(CH.chatCancel),
    clear: () => ipcRenderer.invoke(CH.chatClear)
  },
  git: {
    status: () => ipcRenderer.invoke(CH.gitStatus)
  },
  window: {
    minimize: () => ipcRenderer.invoke(CH.windowMinimize),
    maximize: () => ipcRenderer.invoke(CH.windowMaximize),
    close: () => ipcRenderer.invoke(CH.windowClose)
  },
  vault: {
    list: () => ipcRenderer.invoke(CH.vaultList),
    set: (id: string, secret: string) => ipcRenderer.invoke(CH.vaultSet, id, secret),
    remove: (id: string) => ipcRenderer.invoke(CH.vaultRemove, id)
  },
  confirmations: {
    pending: () => ipcRenderer.invoke(CH.confirmationsPending),
    history: (limit?: number) => ipcRenderer.invoke(CH.confirmationsHistory, limit),
    approve: (id: string) => ipcRenderer.invoke(CH.confirmationsApprove, id),
    reject: (id: string, reason: string) => ipcRenderer.invoke(CH.confirmationsReject, id, reason)
  },
  on: {
    runStarted: (cb) => subscribe(CH.eventRunStarted, cb),
    runChunk: (cb) => subscribe(CH.eventRunChunk, cb),
    runCompleted: (cb) => subscribe(CH.eventRunCompleted, cb),
    skillsIndexed: (cb) => subscribe(CH.eventSkillsIndexed, cb),
    routinesUpdated: (cb) => subscribe(CH.eventRoutinesUpdated, cb),
    confirmationPending: (cb) => subscribe(CH.eventConfirmationPending, cb),
    confirmationDecided: (cb) => subscribe(CH.eventConfirmationDecided, cb),
    toolCalled: (cb) => subscribe(CH.eventToolCalled, cb),
    memoryProgress: (cb) => subscribe(CH.eventMemoryProgress, cb),
    memoryCompleted: (cb) => subscribe(CH.eventMemoryCompleted, cb),
    windowMaximized: (cb) => subscribe(CH.eventWindowMaximized, cb),
    chatChunk: (cb) => subscribe(CH.eventChatChunk, cb),
    chatCompleted: (cb) => subscribe(CH.eventChatCompleted, cb)
  }
}

// contextIsolation is on, so this is the renderer's only route into the main
// process. Nothing else is exposed - no `require`, no raw ipcRenderer.
contextBridge.exposeInMainWorld('arms', bridge)
