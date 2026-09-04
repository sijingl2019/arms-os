/**
 * Types shared between the OS Core Services and (eventually) the renderer.
 * Nothing in here may import from `@main/*` - this file is the contract, not
 * an implementation detail.
 */

/** Where a SKILL.md was found. Workspace skills win over user skills on a name clash. */
export type SkillSource = 'workspace' | 'user'

/**
 * The guardrail sections of a SKILL.md, per 架构规范 §4.1. Stored but not yet
 * enforced - enforcement is the Connector Gateway's Guardrail middleware.
 */
export interface SkillGuardrails {
  /** 「绝对不能做的事」 */
  forbidden: string[]
  /** 「需要人工确认的动作」 */
  confirmRequired: string[]
  /** 「依赖的 Application」 */
  connectors: string[]
}

export interface SkillMeta {
  id: string
  name: string
  description: string
  source: SkillSource
  /** Absolute path of the SKILL.md file - the source of truth. */
  path: string
  triggers: string[]
  modelHint: string | null
  effortHint: string | null
  guardrails: SkillGuardrails
  /** Line count, so the deck can flag files past the 150-line split threshold. */
  lines: number
  /** sha256 of the file, used to skip re-parsing unchanged skills. */
  contentHash: string
  indexedAt: string
}

export interface RefreshResult {
  added: number
  updated: number
  removed: number
  unchanged: number
  /** Non-fatal problems: an unreadable file, broken frontmatter, a name clash. */
  warnings: string[]
}

export type AgentId = 'claude' | 'codex'

/**
 * `interrupted` is assigned at startup to runs the DB still believes are
 * running - the process died with them.
 */
export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'interrupted'

/** Who asked for this run. Kept per-run so Routine failures stay attributable. */
export type RunTrigger = 'dashboard' | 'routine' | 'cli' | 'chat'

export interface RunRecord {
  runId: string
  /** null for a raw-prompt run that is not tied to a registered skill. */
  skillId: string | null
  /** Set when a Routine triggered this run, so its history stays attributable. */
  routineId: string | null
  label: string
  trigger: RunTrigger
  agent: AgentId
  model: string | null
  effort: string | null
  cwd: string
  /** The command line as it was (or would have been) executed, for audit. */
  command: string
  status: RunStatus
  exitCode: number | null
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  output: string
  error: string | null
}

export interface SkillRunRequest {
  skillId: string
  trigger: RunTrigger
  /** Stamped onto the run record when the Routine Scheduler is the caller. */
  routineId?: string
  args?: string
  agent?: AgentId
  /** Falls back to the skill's `model_hint`. */
  model?: string
  /** Falls back to the skill's `effort_hint`. */
  effort?: string
  cwd?: string
  timeoutMs?: number
  /** Record the command that would run, but do not spawn anything. */
  dryRun?: boolean
}

export interface RunHistoryQuery {
  skillId?: string
  routineId?: string
  limit?: number
}

/**
 * The main-process event bus contract (系统设计文档 §5.2). Modules talk through
 * these instead of importing each other, so the Routine Scheduler can be added
 * later by emitting `routine:fired` and nothing else has to change.
 */
export interface ArmsEvents {
  'routine:fired': RoutineFired
  'routine:skipped': { routineId: string; reason: RoutineSkipReason; at: string }
  'routines:updated': { routineId: string | null }
  'skill:run:started': { runId: string; skillId: string | null }
  'skill:run:chunk': { runId: string; stream: 'stdout' | 'stderr'; chunk: string }
  'skill:run:completed': {
    runId: string
    skillId: string | null
    routineId: string | null
    status: RunStatus
    exitCode: number | null
    endedAt: string
  }
  'skills:index:updated': RefreshResult
  'gateway:confirmation:pending': PendingConfirmation
  'gateway:confirmation:decided': { confirmationId: string; status: ConfirmationStatus }
  'gateway:tool:called': ToolCallRecord
}

/* --------------------------------------------------------------- routines */

/**
 * What to do about a trigger that came due while the app was closed
 * (系统设计文档 §9). `skip` is the default: catching up a backlog is how a
 * Routine acquires duplicate side effects, which 架构规范 §6.2 warns about.
 */
export type MissedRunPolicy = 'skip' | 'catch-up-once'

export type RoutineSkipReason =
  | 'missed-while-offline'
  | 'previous-run-still-active'
  | 'unknown-skill'

export type RoutineLastStatus = RunStatus | 'skipped'

export interface RoutineFired {
  routineId: string
  skillId: string
  args?: string
  /** 1 for the scheduled firing; higher for automatic retries. */
  attempt: number
}

export interface RoutineDef {
  id: string
  name: string
  skillId: string
  /** croner expression. Validated on write, so a bad one never reaches the loop. */
  cron: string
  /** IANA zone; null means the host's local time. */
  timezone: string | null
  args: string | null
  agent: AgentId | null
  model: string | null
  effort: string | null
  enabled: boolean
  missedRunPolicy: MissedRunPolicy
  /** 0 disables retries. 架构规范 §6.2 requires this to be explicit. */
  maxRetries: number
  retryDelayMs: number
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: RoutineLastStatus | null
  lastRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface RoutineInput {
  name: string
  skillId: string
  cron: string
  timezone?: string | null
  args?: string | null
  agent?: AgentId | null
  model?: string | null
  effort?: string | null
  enabled?: boolean
  missedRunPolicy?: MissedRunPolicy
  maxRetries?: number
  retryDelayMs?: number
}

export interface RoutineStartupReport {
  loaded: number
  missed: number
  caughtUp: number
  skipped: number
}

/* ------------------------------------------------------------------- IPC */

export interface SystemStatus {
  workspaceRoot: string
  stateDir: string
  dbPath: string
  runLogPath: string
  defaultAgent: AgentId
  scanRoots: Array<{ dir: string; source: SkillSource }>
  skillCount: number
  routineCount: number
  nextTriggerAt: string | null
  /** Runs a previous session left dangling, reconciled at startup. */
  interruptedRuns: number
  scheduler: RoutineStartupReport | null
}

export interface SystemTaskExport {
  platform: string
  command: string
  notes: string[]
}

/**
 * The surface `contextBridge` exposes to the renderer. The renderer never sees
 * the filesystem, credentials, SQL or a child process - only these calls
 * (系统设计文档 §5.1).
 */
export interface ArmsOsBridge {
  skills: {
    list(): Promise<SkillMeta[]>
    get(id: string): Promise<SkillMeta | null>
    refresh(): Promise<RefreshResult>
    writeIndex(): Promise<string>
    run(req: SkillRunRequest): Promise<RunRecord>
    cancel(runId: string): Promise<boolean>
  }
  runs: {
    history(query?: RunHistoryQuery): Promise<RunRecord[]>
  }
  routines: {
    list(): Promise<RoutineDef[]>
    create(input: RoutineInput): Promise<RoutineDef>
    update(id: string, patch: Partial<RoutineInput>): Promise<RoutineDef>
    remove(id: string): Promise<boolean>
    exportSystemTask(id: string): Promise<SystemTaskExport>
  }
  system: {
    status(): Promise<SystemStatus>
  }
  /** Every subscribe returns its own unsubscribe. */
  on: {
    runStarted(cb: (e: ArmsEvents['skill:run:started']) => void): () => void
    runChunk(cb: (e: ArmsEvents['skill:run:chunk']) => void): () => void
    runCompleted(cb: (e: ArmsEvents['skill:run:completed']) => void): () => void
    skillsIndexed(cb: (e: ArmsEvents['skills:index:updated']) => void): () => void
    routinesUpdated(cb: (e: ArmsEvents['routines:updated']) => void): () => void
  }
}

/* --------------------------------------------------------------- gateway */

export type RiskLevel = 'read-only' | 'write-reversible' | 'write-irreversible'

export type ConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface PendingConfirmation {
  confirmationId: string
  connectorId: string
  toolName: string
  qualifiedName: string
  /** Shown to the human verbatim - this is what they are approving. */
  args: Record<string, unknown>
  risk: RiskLevel
  runId: string | null
  status: ConfirmationStatus
  reason: string | null
  requestedAt: string
  expiresAt: string
  decidedAt: string | null
}

/** How a tool call ended, from the Gateway's point of view. */
export type ToolCallOutcome =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'expired'
  | 'blocked'
  | 'timeout'

export interface ToolCallRecord {
  callId: string
  connectorId: string
  toolName: string
  qualifiedName: string
  args: Record<string, unknown>
  risk: RiskLevel
  outcome: ToolCallOutcome
  confirmationId: string | null
  runId: string | null
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  result: string | null
  error: string | null
}

export interface GatewayToolInfo {
  connectorId: string
  toolName: string
  qualifiedName: string
  description: string
  risk: RiskLevel
}

export interface GatewayStatus {
  running: boolean
  /** http://127.0.0.1:<port>/mcp, or null when the server is not listening. */
  endpoint: string | null
  manifestPath: string
  connectors: Array<{
    id: string
    transport: string
    enabled: boolean
    toolCount: number
    error: string | null
  }>
  tools: GatewayToolInfo[]
  issues: string[]
  vault: { kind: string; available: boolean }
  pendingConfirmations: number
}
