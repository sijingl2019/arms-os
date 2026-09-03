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
  limit?: number
}

/**
 * The main-process event bus contract (系统设计文档 §5.2). Modules talk through
 * these instead of importing each other, so the Routine Scheduler can be added
 * later by emitting `routine:fired` and nothing else has to change.
 */
export interface ArmsEvents {
  'routine:fired': { routineId: string; skillId: string; args?: string }
  'skill:run:started': { runId: string; skillId: string | null }
  'skill:run:chunk': { runId: string; stream: 'stdout' | 'stderr'; chunk: string }
  'skill:run:completed': {
    runId: string
    skillId: string | null
    status: RunStatus
    exitCode: number | null
    endedAt: string
  }
  'skills:index:updated': RefreshResult
}
