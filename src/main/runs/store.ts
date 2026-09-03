import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { RunHistoryQuery, RunRecord, RunStatus } from '@shared/types'
import type { Db } from '../db'

interface RunRow {
  run_id: string
  skill_id: string | null
  label: string
  trigger: string
  agent: string
  model: string | null
  effort: string | null
  cwd: string
  command: string
  status: string
  exit_code: number | null
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  output: string
  error: string | null
}

function toRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    skillId: row.skill_id,
    label: row.label,
    trigger: row.trigger as RunRecord['trigger'],
    agent: row.agent as RunRecord['agent'],
    model: row.model,
    effort: row.effort,
    cwd: row.cwd,
    command: row.command,
    status: row.status as RunStatus,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    output: row.output,
    error: row.error
  }
}

export interface RunFinish {
  status: RunStatus
  exitCode: number | null
  endedAt: string
  output: string
  error: string | null
}

export interface RunStoreOptions {
  db: Db
  /** Human-readable mirror of the table (架构规范 §6.2). Omit to skip it. */
  logPath?: string
}

/**
 * Owns the `runs` table. Writes happen in two stages - `create` before the
 * process is spawned, `finish` after it exits - so a crash mid-run still leaves
 * evidence that the run was attempted.
 */
export class RunStore {
  private readonly db: Db
  private readonly logPath: string | undefined

  constructor({ db, logPath }: RunStoreOptions) {
    this.db = db
    this.logPath = logPath
  }

  create(record: RunRecord): RunRecord {
    this.db
      .prepare(`
        INSERT INTO runs (run_id, skill_id, label, trigger, agent, model, effort, cwd,
                          command, status, exit_code, started_at, ended_at, duration_ms,
                          output, error)
        VALUES (@run_id, @skill_id, @label, @trigger, @agent, @model, @effort, @cwd,
                @command, @status, @exit_code, @started_at, @ended_at, @duration_ms,
                @output, @error)
      `)
      .run({
        run_id: record.runId,
        skill_id: record.skillId,
        label: record.label,
        trigger: record.trigger,
        agent: record.agent,
        model: record.model,
        effort: record.effort,
        cwd: record.cwd,
        command: record.command,
        status: record.status,
        exit_code: record.exitCode,
        started_at: record.startedAt,
        ended_at: record.endedAt,
        duration_ms: record.durationMs,
        output: record.output,
        error: record.error
      })
    return record
  }

  finish(runId: string, finish: RunFinish): RunRecord | undefined {
    const started = this.get(runId)?.startedAt
    const durationMs = started
      ? new Date(finish.endedAt).getTime() - new Date(started).getTime()
      : null

    this.db
      .prepare(`
        UPDATE runs
           SET status = @status, exit_code = @exit_code, ended_at = @ended_at,
               duration_ms = @duration_ms, output = @output, error = @error
         WHERE run_id = @run_id
      `)
      .run({
        run_id: runId,
        status: finish.status,
        exit_code: finish.exitCode,
        ended_at: finish.endedAt,
        duration_ms: durationMs,
        output: finish.output,
        error: finish.error
      })

    return this.get(runId)
  }

  get(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as
      | RunRow
      | undefined
    return row ? toRecord(row) : undefined
  }

  list({ skillId, limit = 50 }: RunHistoryQuery = {}): RunRecord[] {
    const rows = skillId
      ? (this.db
          .prepare('SELECT * FROM runs WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?')
          .all(skillId, limit) as RunRow[])
      : (this.db
          .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
          .all(limit) as RunRow[])
    return rows.map(toRecord)
  }

  /**
   * Reconcile at startup: anything the table still calls `running` belongs to a
   * process that died with the previous session.
   */
  markInterrupted(endedAt = new Date().toISOString()): number {
    const info = this.db
      .prepare(`
        UPDATE runs
           SET status = 'interrupted', ended_at = @ended_at,
               duration_ms = CAST((julianday(@ended_at) - julianday(started_at)) * 86400000 AS INTEGER),
               error = COALESCE(error, 'process did not survive an app restart')
         WHERE status = 'running'
      `)
      .run({ ended_at: endedAt })
    return info.changes
  }

  /** Best-effort append to runs.log; a logging failure must not fail a run. */
  async appendLog(record: RunRecord): Promise<void> {
    if (!this.logPath) return
    const seconds = record.durationMs === null ? 'n/a' : `${Math.round(record.durationMs / 1000)}s`
    const line =
      `${record.startedAt}  ${record.status.toUpperCase().padEnd(11)} ${record.label}  ` +
      `[${record.agent}${record.model ? `/${record.model}` : ''}` +
      `${record.effort ? `/${record.effort}` : ''}]  via=${record.trigger}  ` +
      `exit=${record.exitCode ?? 'n/a'}  ${seconds}  ${record.command}\n`

    try {
      await mkdir(path.dirname(this.logPath), { recursive: true })
      await appendFile(this.logPath, line, 'utf8')
    } catch {
      /* the table is the record of truth; the log is a convenience */
    }
  }
}
