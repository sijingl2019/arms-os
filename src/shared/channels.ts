/**
 * The complete set of IPC channel names. Keeping them in one shared file means
 * a renaming mistake is a type error rather than a silently dead channel.
 */
export const CH = {
  // invoke/handle
  skillsList: 'skills:list',
  skillsRefresh: 'skills:refresh',
  skillsGet: 'skills:get',
  skillsWriteIndex: 'skills:write-index',
  skillsLint: 'skills:lint',
  skillsCreate: 'skills:create',
  skillsReveal: 'skills:reveal',
  skillRun: 'skill:run',
  skillCancel: 'skill:cancel',
  runsHistory: 'runs:history',
  routinesList: 'routines:list',
  routinesCreate: 'routines:create',
  routinesUpdate: 'routines:update',
  routinesRemove: 'routines:remove',
  routinesExport: 'routines:export',
  systemStatus: 'system:status',
  gatewayStatus: 'gateway:status',
  gatewayReload: 'gateway:reload',
  gatewayToolCalls: 'gateway:tool-calls',
  confirmationsPending: 'confirmations:pending',
  confirmationsHistory: 'confirmations:history',
  confirmationsApprove: 'confirmations:approve',
  confirmationsReject: 'confirmations:reject',
  memorySearch: 'memory:search',
  memoryStatus: 'memory:status',
  memoryRefresh: 'memory:refresh',
  memoryWriteRouter: 'memory:write-router',
  memoryOpen: 'memory:open',
  agentsList: 'agents:list',
  gitStatus: 'git:status',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',

  // main -> renderer events
  eventRunStarted: 'event:run-started',
  eventRunChunk: 'event:run-chunk',
  eventRunCompleted: 'event:run-completed',
  eventSkillsIndexed: 'event:skills-indexed',
  eventRoutinesUpdated: 'event:routines-updated',
  eventConfirmationPending: 'event:confirmation-pending',
  eventConfirmationDecided: 'event:confirmation-decided',
  eventToolCalled: 'event:tool-called',
  eventMemoryProgress: 'event:memory-progress',
  eventMemoryCompleted: 'event:memory-completed',
  eventWindowMaximized: 'event:window-maximized'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
