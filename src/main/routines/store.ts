import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import type {
  AgentId,
  MissedRunPolicy,
  RoutineDef,
  RoutineInput,
  RoutineLastStatus
} from '@shared/types'
import type { Db } from '../db'

interface RoutineRow {
  id: string
  name: string
  skill_id: string
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

function toDef(row: RoutineRow): RoutineDef {
  return {
    id: row.id,
    name: row.name,
    skillId: row.skill_id,
    cron: row.cron,
    timezone: row.timezone,
    args: row.args,
    agent: row.agent as AgentId | null,
    model: row.model,
    effort: row.effort,
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
  field: keyof RoutineInput
  message: string
}

/**
 * Reject a routine before it is stored. A cron expression that only fails at
 * tick time would be invisible until the trigger silently never fired - the
 * exact failure mode 架构规范 §6.1 calls the easiest trap to fall into.
 */
export function validateRoutine(input: RoutineInput): RoutineValidationIssue[] {
  const issues: RoutineValidationIssue[] = []

  if (!input.name?.trim()) issues.push({ field: 'name', message: 'name is required' })
  if (!input.skillId?.trim()) issues.push({ field: 'skillId', message: 'skillId is required' })

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

  constructor(db: Db) {
    this.db = db
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
    const issues = validateRoutine(input)
    if (issues.length > 0) throw new RoutineValidationError(issues)

    const timezone = input.timezone ?? null
    const enabled = input.enabled ?? true
    const stamp = now.toISOString()

    const def: RoutineDef = {
      id: randomUUID(),
      name: input.name.trim(),
      skillId: input.skillId.trim(),
      cron: input.cron.trim(),
      timezone,
      args: input.args ?? null,
      agent: input.agent ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      enabled,
      missedRunPolicy: input.missedRunPolicy ?? 'skip',
      maxRetries: input.maxRetries ?? 0,
      retryDelayMs: input.retryDelayMs ?? 60_000,
      nextRunAt: enabled ? nextOccurrence(input.cron.trim(), timezone, now) : null,
      lastRunAt: null,
      lastStatus: null,
      lastRunId: null,
      createdAt: stamp,
      updatedAt: stamp
    }

    this.db
      .prepare(
        `INSERT INTO routines (id, name, skill_id, cron, timezone, args, agent, model, effort,
                               enabled, missed_run_policy, max_retries, retry_delay_ms,
                               next_run_at, last_run_at, last_status, last_run_id,
                               created_at, updated_at)
         VALUES (@id, @name, @skill_id, @cron, @timezone, @args, @agent, @model, @effort,
                 @enabled, @missed_run_policy, @max_retries, @retry_delay_ms,
                 @next_run_at, NULL, NULL, NULL, @created_at, @updated_at)`
      )
      .run({
        id: def.id,
        name: def.name,
        skill_id: def.skillId,
        cron: def.cron,
        timezone: def.timezone,
        args: def.args,
        agent: def.agent,
        model: def.model,
        effort: def.effort,
        enabled: def.enabled ? 1 : 0,
        missed_run_policy: def.missedRunPolicy,
        max_retries: def.maxRetries,
        retry_delay_ms: def.retryDelayMs,
        next_run_at: def.nextRunAt,
        created_at: def.createdAt,
        updated_at: def.updatedAt
      })

    return def
  }

  /**
   * Patch a routine. Changing the schedule or re-enabling recomputes
   * `next_run_at` from `now`, so an edit never leaves a stale due time behind.
   */
  update(id: string, patch: Partial<RoutineInput>, now = new Date()): RoutineDef {
    const current = this.get(id)
    if (!current) throw new Error(`unknown routine: ${id}`)

    const merged: RoutineInput = {
      name: patch.name ?? current.name,
      skillId: patch.skillId ?? current.skillId,
      cron: patch.cron ?? current.cron,
      timezone: patch.timezone === undefined ? current.timezone : patch.timezone,
      args: patch.args === undefined ? current.args : patch.args,
      agent: patch.agent === undefined ? current.agent : patch.agent,
      model: patch.model === undefined ? current.model : patch.model,
      effort: patch.effort === undefined ? current.effort : patch.effort,
      enabled: patch.enabled ?? current.enabled,
      missedRunPolicy: patch.missedRunPolicy ?? current.missedRunPolicy,
      maxRetries: patch.maxRetries ?? current.maxRetries,
      retryDelayMs: patch.retryDelayMs ?? current.retryDelayMs
    }

    const issues = validateRoutine(merged)
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
            SET name = @name, skill_id = @skill_id, cron = @cron, timezone = @timezone,
                args = @args, agent = @agent, model = @model, effort = @effort,
                enabled = @enabled, missed_run_policy = @missed_run_policy,
                max_retries = @max_retries, retry_delay_ms = @retry_delay_ms,
                next_run_at = @next_run_at, updated_at = @updated_at
          WHERE id = @id`
      )
      .run({
        id,
        name: merged.name.trim(),
        skill_id: merged.skillId.trim(),
        cron: merged.cron.trim(),
        timezone,
        args: merged.args ?? null,
        agent: merged.agent ?? null,
        model: merged.model ?? null,
        effort: merged.effort ?? null,
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
