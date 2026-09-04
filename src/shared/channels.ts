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
  skillRun: 'skill:run',
  skillCancel: 'skill:cancel',
  runsHistory: 'runs:history',
  routinesList: 'routines:list',
  routinesCreate: 'routines:create',
  routinesUpdate: 'routines:update',
  routinesRemove: 'routines:remove',
  routinesExport: 'routines:export',
  systemStatus: 'system:status',

  // main -> renderer events
  eventRunStarted: 'event:run-started',
  eventRunChunk: 'event:run-chunk',
  eventRunCompleted: 'event:run-completed',
  eventSkillsIndexed: 'event:skills-indexed',
  eventRoutinesUpdated: 'event:routines-updated'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
