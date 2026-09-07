import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import type {
  AgentId,
  MissedRunPolicy,
  RoutineDef,
  RoutineInput,
  RoutineLastStatus,
  RoutineResult,
  RoutineTarget,
  RoutineTargetInput,
  RunStatus
} from '@shared/types'
import type { Db } from '../db'

interface RoutineRow {
  id: string
  name: string
  target_kind: string
  skill_id: string | null
  tool_name: string | null
  tool_args: string | null
  cron: string
  timezone: string | null
  args: string | null
  agent: string | null
  model: string | null
  effort: string | null
  enabled: number
  missed_run_policy: string
  max_retries: number
  retry_delay_ms: number
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_run_id: string | null
  created_at: string
  updated_at: string
}

function parseToolArgs(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function toTarget(row: RoutineRow): RoutineTarget {
  if (row.target_kind === 'tool') {
    return { kind: 'tool', toolName: row.tool_name ?? '', toolArgs: parseToolArgs(row.tool_args) }
  }
  return {
    kind: 'skill',
    skillId: row.skill_id ?? '',
    args: row.args,
    agent: row.agent as AgentId | null,
    model: row.model,
    effort: row.effort
  }
}

function toDef(row: RoutineRow): RoutineDef {
  return {
    id: row.id,
    name: row.name,
    target: toTarget(row),
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    missedRunPolicy: row.missed_run_policy as MissedRunPolicy,
    maxRetries: row.max_retries,
    retryDelayMs: row.retry_delay_ms,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status as RoutineLastStatus | null,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Build a croner job for a routine's schedule.
 *
 * @throws if the expression or timezone is invalid - callers validate on write
 *   so a broken pattern can never reach the scheduler loop.
 */
export function cronFor(cron: string, timezone: string | null): Cron {
  return timezone ? new Cron(cron, { timezone }) : new Cron(cron)
}

/** Next occurrence strictly after `from`, or null for an exhausted schedule. */
export function nextOccurrence(
  cron: string,
  timezone: string | null,
  from: Date
): string | null {
  return cronFor(cron, timezone).nextRun(from)?.toISOString() ?? null
}

export interface RoutineValidationIssue {
  field: keyof RoutineInput | 'target'
  message: string
}

/**
 * Resolves whether a target may be scheduled at all.
 *
 * Injected rather than imported so the store stays pure persistence, and
 * supplied at construction rather than per call so no write path can skip it -
 * the risk rule for tool targets must not be bypassable.
 */
export type TargetChecker = (target: RoutineTargetInput) => string | null

/**
 * Reject a routine before it is stored. A cron expression that only fails at
 * tick time would be invisible until the trigger silently never fired - the
 * exact failure mode 架构规范 §6.1 calls the easiest trap to fall into.
 */
export function validateRoutine(
  input: RoutineInput,
  checkTarget?: TargetChecker
): RoutineValidationIssue[] {
  const issues: RoutineValidationIssue[] = []

  if (!input.name?.trim()) issues.push({ field: 'name', message: 'name is required' })

  const target = input.target
  if (!target) {
    issues.push({ field: 'target', message: 'target is required' })
  } else if (target.kind === 'skill') {
    if (!target.skillId?.trim()) issues.push({ field: 'target', message: 'skillId is required' })
  } else if (target.kind === 'tool') {
    if (!target.toolName?.trim()) issues.push({ field: 'target', message: 'toolName is required' })
    else if (!target.toolName.includes('.')) {
      issues.push({ field: 'target', message: 'toolName must be "<connector>.<tool>"' })
    }
  } else {
    issues.push({ field: 'target', message: 'target.kind must be "skill" or "tool"' })
  }

  if (target && checkTarget) {
    const problem = checkTarget(target)
    if (problem) issues.push({ field: 'target', message: problem })
  }

  if (!input.cron?.trim()) {
    issues.push({ field: 'cron', message: 'cron is required' })
  } else {
    try {
      const job = cronFor(input.cron, input.timezone ?? null)
      if (!job.nextRun()) {
        issues.push({ field: 'cron', message: 'expression has no future occurrence' })
      }
    } catch (err) {
      issues.push({ field: 'cron', message: (err as Error).message })
    }
  }

  if (input.maxRetries !== undefined && (input.maxRetries < 0 || !Number.isInteger(input.maxRetries))) {
    issues.push({ field: 'maxRetries', message: 'maxRetries must be a non-negative integer' })
  }
  if (input.retryDelayMs !== undefined && input.retryDelayMs < 0) {
    issues.push({ field: 'retryDelayMs', message: 'retryDelayMs must not be negative' })
  }

  return issues
}

export class RoutineValidationError extends Error {
  readonly issues: RoutineValidationIssue[]

  constructor(issues: RoutineValidationIssue[]) {
    super(`invalid routine: ${issues.map((i) => `${i.field} - ${i.message}`).join('; ')}`)
    this.name = 'RoutineValidationError'
    this.issues = issues
  }
}

/**
 * Owns the `routines` table. Pure persistence plus schedule arithmetic - it
 * never fires anything; that is the scheduler's job.
 */
export class RoutineStore {
  private readonly db: Db
  private readonly checkTarget: TargetChecker | undefined

  constructor(db: Db, checkTarget?: TargetChecker) {
    this.db = db
    this.checkTarget = checkTarget
  }

  /** Flatten a target into the row's columns. */
  private targetColumns(target: RoutineTargetInput): {
    target_kind: string
    skill_id: string | null
    tool_name: string | null
    tool_args: string | null
    args: string | null
    agent: string | null
    model: string | null
    effort: string | null
  } {
    if (target.kind === 'tool') {
      return {
        target_kind: 'tool',
        skill_id: null,
        tool_name: target.toolName.trim(),
        tool_args: JSON.stringify(target.toolArgs ?? {}),
        args: null,
        agent: null,
        model: null,
        effort: null
      }
    }
    return {
      target_kind: 'skill',
      skill_id: target.skillId.trim(),
      tool_name: null,
      tool_args: null,
      args: target.args ?? null,
      agent: target.agent ?? null,
      model: target.model ?? null,
      effort: target.effort ?? null
    }
  }

  list(): RoutineDef[] {
    const rows = this.db.prepare('SELECT * FROM routines ORDER BY name').all() as RoutineRow[]
    return rows.map(toDef)
  }

  get(id: string): RoutineDef | undefined {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as
      | RoutineRow
      | undefined
    return row ? toDef(row) : undefined
  }

  /** Enabled routines whose next occurrence has arrived. */
  due(now: Date): RoutineDef[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM routines
          WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at`
      )
      .all(now.toISOString()) as RoutineRow[]
    return rows.map(toDef)
  }

  create(input: RoutineInput, now = new Date()): RoutineDef {
    const issues = validateRoutine(input, this.checkTarget)
    if (issues.length > 0) throw new RoutineValidationError(issues)

    const timezone = input.timezone ?? null
    const enabled = input.enabled ?? true
    const stamp = now.toISOString()

    const columns = this.targetColumns(input.target)
    const id = randomUUID()

    this.db
      .prepare(
        `INSERT INTO routines (id, name, target_kind, skill_id, tool_name, tool_args, cron,
                               timezone, args, agent, model, effort, enabled,
                               missed_run_policy, max_retries, retry_delay_ms,
                               next_run_at, last_run_at, last_status, last_run_id,
                               created_at, updated_at)
         VALUES (@id, @name, @target_kind, @skill_id, @tool_name, @tool_args, @cron,
                 @timezone, @args, @agent, @model, @effort, @enabled,
                 @missed_run_policy, @max_retries, @retry_delay_ms,
                 @next_run_at, NULL, NULL, NULL, @created_at, @updated_at)`
      )
      .run({
        id,
        name: input.name.trim(),
        ...columns,
        cron: input.cron.trim(),
        timezone,
        enabled: enabled ? 1 : 0,
        missed_run_policy: input.missedRunPolicy ?? 'skip',
        max_retries: input.maxRetries ?? 0,
        retry_delay_ms: input.retryDelayMs ?? 60_000,
        next_run_at: enabled ? nextOccurrence(input.cron.trim(), timezone, now) : null,
        created_at: stamp,
        updated_at: stamp
      })

    const created = this.get(id)
    if (!created) throw new Error('routine vanished immediately after insert')
    return created
  }

  /**
   * Patch a routine. Changing the schedule or re-enabling recomputes
   * `next_run_at` from `now`, so an edit never leaves a stale due time behind.
   */
  update(id: string, patch: Partial<RoutineInput>, now = new Date()): RoutineDef {
    const current = this.get(id)
    if (!current) throw new Error(`unknown routine: ${id}`)

    // A patch may replace the target wholesale, or leave it untouched. Merging
    // *within* a target kind is deliberately not supported: switching a routine
    // from a skill to a tool while half its old fields survive is a bug factory.
    const target: RoutineTargetInput = patch.target ?? current.target

    const merged: RoutineInput = {
      name: patch.name ?? current.name,
      target,
      cron: patch.cron ?? current.cron,
      timezone: patch.timezone === undefined ? current.timezone : patch.timezone,
      enabled: patch.enabled ?? current.enabled,
      missedRunPolicy: patch.missedRunPolicy ?? current.missedRunPolicy,
      maxRetries: patch.maxRetries ?? current.maxRetries,
      retryDelayMs: patch.retryDelayMs ?? current.retryDelayMs
    }

    const issues = validateRoutine(merged, this.checkTarget)
    if (issues.length > 0) throw new RoutineValidationError(issues)

    const timezone = merged.timezone ?? null
    const enabled = merged.enabled ?? true
    const scheduleChanged =
      merged.cron !== current.cron || timezone !== current.timezone || enabled !== current.enabled

    const nextRunAt = !enabled
      ? null
      : scheduleChanged || current.nextRunAt === null
        ? nextOccurrence(merged.cron, timezone, now)
        : current.nextRunAt

    this.db
      .prepare(
        `UPDATE routines
            SET name = @name, target_kind = @target_kind, skill_id = @skill_id,
                tool_name = @tool_name, tool_args = @tool_args, cron = @cron,
                timezone = @timezone, args = @args, agent = @agent, model = @model,
                effort = @effort, enabled = @enabled,
                missed_run_policy = @missed_run_policy, max_retries = @max_retries,
                retry_delay_ms = @retry_delay_ms, next_run_at = @next_run_at,
                updated_at = @updated_at
          WHERE id = @id`
      )
      .run({
        id,
        name: merged.name.trim(),
        ...this.targetColumns(target),
        cron: merged.cron.trim(),
        timezone,
        enabled: enabled ? 1 : 0,
        missed_run_policy: merged.missedRunPolicy ?? 'skip',
        max_retries: merged.maxRetries ?? 0,
        retry_delay_ms: merged.retryDelayMs ?? 60_000,
        next_run_at: nextRunAt,
        updated_at: now.toISOString()
      })

    const updated = this.get(id)
    if (!updated) throw new Error(`routine vanished during update: ${id}`)
    return updated
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes > 0
  }

  /** Advance `next_run_at` to the first occurrence strictly after `from`. */
  reschedule(id: string, from: Date): string | null {
    const routine = this.get(id)
    if (!routine) return null
    const next = routine.enabled
      ? nextOccurrence(routine.cron, routine.timezone, from)
      : null
    this.db
      .prepare('UPDATE routines SET next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(next, from.toISOString(), id)
    return next
  }

  markFired(id: string, at: Date, runId: string | null): void {
    this.db
      .prepare(
        `UPDATE routines
            SET last_run_at = @at, last_run_id = @run_id, last_status = 'running',
                updated_at = @at
          WHERE id = @id`
      )
      .run({ id, at: at.toISOString(), run_id: runId })
  }

  /**
   * Record the latest value a routine produced.
   *
   * One row per routine, upserted - this is the widget's data source, and it
   * must not live in `tool_calls`, which is an audit trail with a retention
   * policy that would delete the widget's data out from under it.
   */
  saveResult(
    routineId: string,
    status: RunStatus,
    result: string | null,
    error: string | null,
    at = new Date()
  ): void {
    this.db
      .prepare(
        `INSERT INTO routine_results (routine_id, status, result, error, updated_at)
         VALUES (@id, @status, @result, @error, @at)
         ON CONFLICT(routine_id) DO UPDATE SET
           status = excluded.status, result = excluded.result,
           error = excluded.error, updated_at = excluded.updated_at`
      )
      .run({ id: routineId, status, result, error, at: at.toISOString() })
  }

  result(routineId: string): RoutineResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM routine_results WHERE routine_id = ?')
      .get(routineId) as
      | { routine_id: string; status: string; result: string | null; error: string | null; updated_at: string }
      | undefined
    if (!row) return undefined
    return {
      routineId: row.routine_id,
      status: row.status as RoutineLastStatus,
      result: row.result,
      error: row.error,
      updatedAt: row.updated_at
    }
  }

  results(): RoutineResult[] {
    const rows = this.db.prepare('SELECT * FROM routine_results').all() as Array<{
      routine_id: string
      status: string
      result: string | null
      error: string | null
      updated_at: string
    }>
    return rows.map((row) => ({
      routineId: row.routine_id,
      status: row.status as RoutineLastStatus,
      result: row.result,
      error: row.error,
      updatedAt: row.updated_at
    }))
  }

  markStatus(id: string, status: RoutineLastStatus, at: Date, runId?: string | null): void {
    this.db
      .prepare(
        `UPDATE routines
            SET last_status = @status, updated_at = @at,
                last_run_id = COALESCE(@run_id, last_run_id)
          WHERE id = @id`
      )
      .run({ id, status, at: at.toISOString(), run_id: runId ?? null })
  }
}
