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
  /** A tool-target routine finished; the skill path reports via skill:run:completed. */
  'routine:tool:completed': {
    routineId: string
    status: RunStatus
    result: string | null
    error: string | null
  }
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
  'memory:index:progress': MemoryIndexProgress
  'memory:index:completed': MemoryIndexResult
  'skills:linted': SkillLintReport
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
  | 'unknown-tool'
  /**
   * The tool was safe enough to schedule when the routine was created, but the
   * manifest has since raised it to write-irreversible. Checked again at fire
   * time rather than trusted from creation, because the manifest is a file the
   * user edits underneath us.
   */
  | 'tool-risk-raised'

export type RoutineLastStatus = RunStatus | 'skipped'

/**
 * What a routine fires.
 *
 * A discriminated union rather than optional fields, so a tool routine cannot
 * carry a model hint and a skill routine cannot carry tool arguments - both
 * would be meaningless, and the type system is a better place to say so than a
 * comment.
 */
export type RoutineTarget =
  | {
      kind: 'skill'
      skillId: string
      /** Appended to the prompt. */
      args: string | null
      agent: AgentId | null
      model: string | null
      effort: string | null
    }
  | {
      kind: 'tool'
      /** `<connector>.<tool>`, as the Gateway exposes it. */
      toolName: string
      toolArgs: Record<string, unknown>
    }

export type RoutineTargetInput =
  | {
      kind: 'skill'
      skillId: string
      args?: string | null
      agent?: AgentId | null
      model?: string | null
      effort?: string | null
    }
  | { kind: 'tool'; toolName: string; toolArgs?: Record<string, unknown> }

export interface RoutineFired {
  routineId: string
  target: RoutineTarget
  /** 1 for the scheduled firing; higher for automatic retries. */
  attempt: number
}

/** The latest value a routine produced, for a widget to render. */
export interface RoutineResult {
  routineId: string
  status: RoutineLastStatus
  /** Tool output as text, or null when the run failed. */
  result: string | null
  error: string | null
  updatedAt: string
}

export interface RoutineDef {
  id: string
  name: string
  target: RoutineTarget
  /** croner expression. Validated on write, so a bad one never reaches the loop. */
  cron: string
  /** IANA zone; null means the host's local time. */
  timezone: string | null
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
  target: RoutineTargetInput
  cron: string
  timezone?: string | null
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
    /** Run the health checks over every indexed skill. */
    lint(): Promise<SkillLintReport>
    create(req: NewSkillRequest): Promise<{ id: string; file: string }>
    /** Show a skill's SKILL.md in the OS file manager. */
    reveal(id: string): Promise<boolean>
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
    /** The latest value a tool routine produced, for a widget to render. */
    result(id: string): Promise<RoutineResult | null>
  }
  system: {
    status(): Promise<SystemStatus>
  }
  gateway: {
    status(): Promise<GatewayStatus>
    reload(): Promise<string[]>
    toolCalls(limit?: number): Promise<ToolCallRecord[]>
    /** Apply the audit retention policy now. */
    prune(): Promise<{ aged: number; noise: number; total: number }>
    /** VACUUM: hand the space pruned rows freed back to the filesystem. */
    compact(): Promise<{ before: number; after: number }>
  }
  memory: {
    search(query: MemorySearchQuery): Promise<MemorySearchHit[]>
    status(): Promise<MemoryIndexStatus>
    refresh(opts?: { force?: boolean; writeRouter?: boolean }): Promise<MemoryIndexResult>
    /** Regenerate router files without a sweep; `dryRun` only plans. */
    writeRouter(dryRun?: boolean): Promise<string[]>
    /** Hand an indexed file to the OS default app. Rejects paths outside the roots. */
    open(path: string): Promise<OpenResult>
    /** Native folder picker. Resolves to null when the user cancels. */
    chooseRoot(): Promise<string | null>
    /** Replace the root list; returns the stored list and rows pruned. */
    setRoots(roots: string[]): Promise<{ roots: string[]; pruned: number }>
  }
  agents: {
    /** Probe each agent CLI for availability. Runs `--version`, so it is slow-ish. */
    list(): Promise<AgentInfo[]>
  }
  /** The desktop's conversation with the agent, with no skill in front of it. */
  chat: {
    history(): Promise<ChatMessage[]>
    send(text: string, attachments?: ChatAttachment[]): Promise<ChatSendResult>
    /** Opens the OS file picker; returns what the user chose. */
    pickFiles(): Promise<ChatAttachment[]>
    cancel(): Promise<boolean>
    clear(): Promise<void>
  }
  /** Read-only view of the workspace repository, for the desktop's Git widget. */
  git: {
    status(): Promise<GitStatus>
  }
  /** Frameless-window controls, since there is no native title bar to use. */
  window: {
    minimize(): Promise<void>
    /** Toggles; resolves with the resulting maximized state. */
    maximize(): Promise<boolean>
    /** Hides to the tray - quitting stays a tray-menu-only action. */
    close(): Promise<void>
  }
  /**
   * Credential storage. Values only ever travel renderer -> main; nothing here
   * returns a secret.
   */
  vault: {
    list(): Promise<string[]>
    set(id: string, secret: string): Promise<void>
    remove(id: string): Promise<void>
  }
  /** The approval queue behind every write-irreversible action (§2.3). */
  confirmations: {
    pending(): Promise<PendingConfirmation[]>
    history(limit?: number): Promise<PendingConfirmation[]>
    approve(id: string): Promise<boolean>
    reject(id: string, reason: string): Promise<boolean>
  }
  /** Every subscribe returns its own unsubscribe. */
  on: {
    runStarted(cb: (e: ArmsEvents['skill:run:started']) => void): () => void
    runChunk(cb: (e: ArmsEvents['skill:run:chunk']) => void): () => void
    runCompleted(cb: (e: ArmsEvents['skill:run:completed']) => void): () => void
    skillsIndexed(cb: (e: ArmsEvents['skills:index:updated']) => void): () => void
    routinesUpdated(cb: (e: ArmsEvents['routines:updated']) => void): () => void
    confirmationPending(cb: (e: PendingConfirmation) => void): () => void
    confirmationDecided(
      cb: (e: ArmsEvents['gateway:confirmation:decided']) => void
    ): () => void
    toolCalled(cb: (e: ToolCallRecord) => void): () => void
    memoryProgress(cb: (e: MemoryIndexProgress) => void): () => void
    memoryCompleted(cb: (e: MemoryIndexResult) => void): () => void
    /** Fires for system gestures (double-click, Win+Up, snap) too, not just our button. */
    windowMaximized(cb: (maximized: boolean) => void): () => void
    chatChunk(cb: (e: { messageId: string; chunk: string }) => void): () => void
    chatCompleted(cb: (message: ChatMessage) => void): () => void
  }
}

/* ------------------------------------------------------------------ chat */

export type ChatRole = 'user' | 'agent'

/** `streaming` is an agent reply still being written into. */
export type ChatStatus = 'streaming' | 'done' | 'failed' | 'cancelled'

/** A file the user attached. The agent reads it from disk with its own tools. */
export interface ChatAttachment {
  /** Absolute path, which is what actually reaches the agent. */
  path: string
  name: string
  size: number
}

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: string
  status: ChatStatus
  attachments?: ChatAttachment[]
}

/**
 * Refused rather than thrown: an empty box or a second message while the agent
 * is still answering is ordinary, and the chat window shows the reason inline.
 */
export type ChatSendResult =
  | { ok: true; asked: ChatMessage; reply: ChatMessage }
  | { ok: false; reason: string }

/* ---------------------------------------------------------------- agents */

/** One agent CLI, as Settings shows it. */
export interface AgentInfo {
  id: AgentId
  label: string
  /** The executable name, so a missing CLI names what to install. */
  command: string
  isDefault: boolean
  available: boolean
  /** First line of `--version` output, when the CLI answered. */
  version: string | null
  /** Why it is unavailable, when it did not. */
  reason: string | null
}

/* ------------------------------------------------------------------- git */

export interface GitCommit {
  hash: string
  author: string
  /** YYYY-MM-DD, already formatted by `git log --date=short`. */
  date: string
  subject: string
}

/**
 * A snapshot of the workspace repository. Read-only by construction: the widget
 * offers no writes, so this never goes through the Gateway's Guardrail - that
 * guards agent-initiated external actions, not the dashboard reading its own
 * working copy.
 */
export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  commits: GitCommit[]
  /** Set when git is missing, times out, or the directory is not a repo. */
  error: string | null
}

/** `''` on success; otherwise the reason, so the renderer can show it. */
export type OpenResult = string

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
  /** Audit-trail retention windows, so the panel can say what it keeps. */
  retention: { keepDays: number; keepReadOnlyDays: number }
  /** Rows currently in the audit table. */
  toolCallCount: number
  /**
   * Which credentials the manifest asks for and whether each is stored.
   *
   * Presence only - a secret never travels back to the renderer, so the panel
   * can show "set" or "missing" but can never display or leak the value.
   */
  credentials: Array<{ id: string; connectorIds: string[]; present: boolean }>
}

/* ---------------------------------------------------------------- memory */

export interface MemoryEntry {
  path: string
  root: string
  relPath: string
  name: string
  ext: string
  /** Top-level folder under its root; '' for files sitting at the root. */
  area: string
  size: number
  mtimeMs: number
  title: string
  excerpt: string
  indexedAt: string
}

export interface MemorySearchHit {
  path: string
  relPath: string
  name: string
  area: string
  title: string
  /** Excerpt around the match where FTS could produce one. */
  snippet: string
  /** Lower is a better match (FTS5 bm25); 0 for fallback matches. */
  score: number
}

export interface MemorySearchQuery {
  query: string
  area?: string
  limit?: number
}

export interface MemoryIndexProgress {
  phase: 'scanning' | 'writing' | 'routing' | 'done'
  /** Files examined so far. Total is unknown until the sweep finishes. */
  seen: number
  changed: number
  currentRoot: string | null
}

export interface MemoryIndexResult {
  added: number
  updated: number
  removed: number
  unchanged: number
  /** Files skipped by an ignore rule, size cap, or a read error. */
  skipped: number
  durationMs: number
  warnings: string[]
  /** Router files rewritten, when router generation is enabled. */
  routerFiles: string[]
}

export interface MemoryAreaSummary {
  area: string
  files: number
  lastModified: string | null
}

export interface MemoryIndexStatus {
  roots: string[]
  routerRoot: string | null
  indexing: boolean
  totalFiles: number
  areas: MemoryAreaSummary[]
  lastResult: MemoryIndexResult | null
  lastIndexedAt: string | null
}

/* ------------------------------------------------------------ skill lint */

/**
 * Mechanised form of the pre-flight checklist in 架构规范 §11, plus the
 * Skill/Gateway consistency check Connector Gateway 设计文档 §4 asks for.
 */
export type SkillLintRule =
  | 'no-description'
  | 'no-triggers'
  | 'missing-forbidden'
  | 'missing-confirm-section'
  | 'too-long'
  | 'trigger-conflict'
  | 'unknown-connector'
  | 'unguarded-irreversible'
  | 'overstated-risk'

export type SkillLintSeverity = 'error' | 'warning' | 'info'

export interface SkillFinding {
  skillId: string
  rule: SkillLintRule
  severity: SkillLintSeverity
  message: string
  /** What to do about it, in one line. */
  hint: string
}

export interface SkillHealth {
  skillId: string
  errors: number
  warnings: number
  infos: number
}

export interface SkillLintReport {
  findings: SkillFinding[]
  health: SkillHealth[]
  /** True when the Gateway manifest was available to cross-check against. */
  connectorsChecked: boolean
  generatedAt: string
}

export interface NewSkillRequest {
  id: string
  description?: string
  triggers?: string[]
  modelHint?: string
  effortHint?: string
  /** Defaults to the workspace scan root. */
  destination?: string
}
