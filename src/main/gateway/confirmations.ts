import { randomUUID } from 'node:crypto'
import type {
  ConfirmationStatus,
  PendingConfirmation,
  RiskLevel
} from '@shared/types'
import type { ArmsBus } from '../bus'
import type { Db } from '../db'

interface ConfirmationRow {
  confirmation_id: string
  connector_id: string
  tool_name: string
  qualified_name: string
  args: string
  risk: string
  run_id: string | null
  status: string
  reason: string | null
  requested_at: string
  expires_at: string
  decided_at: string | null
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function toPending(row: ConfirmationRow): PendingConfirmation {
  return {
    confirmationId: row.confirmation_id,
    connectorId: row.connector_id,
    toolName: row.tool_name,
    qualifiedName: row.qualified_name,
    args: parseArgs(row.args),
    risk: row.risk as RiskLevel,
    runId: row.run_id,
    status: row.status as ConfirmationStatus,
    reason: row.reason,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at
  }
}

export interface Decision {
  status: Exclude<ConfirmationStatus, 'pending'>
  reason: string | null
}

export interface ConfirmationRequest {
  connectorId: string
  toolName: string
  qualifiedName: string
  args: Record<string, unknown>
  risk: RiskLevel
  runId: string | null
  /** How long the caller is willing to block. */
  timeoutMs: number
}

interface Waiter {
  resolve(decision: Decision): void
  timer: NodeJS.Timeout
}

/**
 * The approval queue behind every write-irreversible action
 * (Connector Gateway 设计文档 §2.3).
 *
 * The Gateway blocks on `request()` until a human decides or the wait expires,
 * so the agent gets one call and one answer. The alternative - handing back a
 * placeholder and expecting the agent to poll - reliably ends with the agent
 * treating the placeholder as success and carrying on.
 */
export class ConfirmationStore {
  private readonly db: Db
  private readonly bus: ArmsBus
  private readonly waiters = new Map<string, Waiter>()

  constructor(db: Db, bus: ArmsBus) {
    this.db = db
    this.bus = bus
  }

  /**
   * Record the request, tell the Dashboard, and wait. Resolves with whatever
   * the human decided, or `expired` when nobody got to it in time.
   */
  async request(req: ConfirmationRequest, now = new Date()): Promise<Decision> {
    const record: PendingConfirmation = {
      confirmationId: randomUUID(),
      connectorId: req.connectorId,
      toolName: req.toolName,
      qualifiedName: req.qualifiedName,
      args: req.args,
      risk: req.risk,
      runId: req.runId,
      status: 'pending',
      reason: null,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + req.timeoutMs).toISOString(),
      decidedAt: null
    }

    this.db
      .prepare(
        `INSERT INTO confirmations (confirmation_id, connector_id, tool_name, qualified_name,
                                    args, risk, run_id, status, requested_at, expires_at)
         VALUES (@id, @connector, @tool, @qualified, @args, @risk, @run, 'pending', @requested, @expires)`
      )
      .run({
        id: record.confirmationId,
        connector: record.connectorId,
        tool: record.toolName,
        qualified: record.qualifiedName,
        args: JSON.stringify(record.args),
        risk: record.risk,
        run: record.runId,
        requested: record.requestedAt,
        expires: record.expiresAt
      })

    this.bus.emit('gateway:confirmation:pending', record)

    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(record.confirmationId)
        this.settle(record.confirmationId, 'expired', 'nobody responded in time')
        resolve({ status: 'expired', reason: 'nobody responded in time' })
      }, req.timeoutMs)
      // A pending approval should not be the reason the process stays alive.
      timer.unref?.()

      this.waiters.set(record.confirmationId, { resolve, timer })
    })
  }

  approve(id: string): boolean {
    return this.decide(id, 'approved', null)
  }

  reject(id: string, reason: string): boolean {
    return this.decide(id, 'rejected', reason)
  }

  private decide(id: string, status: Exclude<ConfirmationStatus, 'pending'>, reason: string | null): boolean {
    const current = this.get(id)
    if (!current || current.status !== 'pending') return false

    this.settle(id, status, reason)

    const waiter = this.waiters.get(id)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.waiters.delete(id)
      waiter.resolve({ status, reason })
    }
    return true
  }

  private settle(id: string, status: ConfirmationStatus, reason: string | null): void {
    this.db
      .prepare(
        `UPDATE confirmations
            SET status = @status, reason = @reason, decided_at = @at
          WHERE confirmation_id = @id AND status = 'pending'`
      )
      .run({ id, status, reason, at: new Date().toISOString() })
    this.bus.emit('gateway:confirmation:decided', { confirmationId: id, status })
  }

  get(id: string): PendingConfirmation | undefined {
    const row = this.db
      .prepare('SELECT * FROM confirmations WHERE confirmation_id = ?')
      .get(id) as ConfirmationRow | undefined
    return row ? toPending(row) : undefined
  }

  listPending(): PendingConfirmation[] {
    const rows = this.db
      .prepare("SELECT * FROM confirmations WHERE status = 'pending' ORDER BY requested_at")
      .all() as ConfirmationRow[]
    return rows.map(toPending)
  }

  history(limit = 50): PendingConfirmation[] {
    const rows = this.db
      .prepare('SELECT * FROM confirmations ORDER BY requested_at DESC LIMIT ?')
      .all(limit) as ConfirmationRow[]
    return rows.map(toPending)
  }

  /**
   * Startup reconciliation: rows still `pending` belong to a process that died
   * holding them. Nothing is waiting on them any more, so they can never be
   * answered - expire them rather than leave them in the queue forever.
   */
  expireStale(now = new Date()): number {
    const info = this.db
      .prepare(
        `UPDATE confirmations
            SET status = 'expired', decided_at = @at,
                reason = COALESCE(reason, 'the app exited while this request was waiting')
          WHERE status = 'pending'`
      )
      .run({ at: now.toISOString() })
    return info.changes
  }

  /** Fail every in-flight wait, e.g. during shutdown. */
  releaseAll(reason = 'the gateway is shutting down'): void {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer)
      this.settle(id, 'expired', reason)
      waiter.resolve({ status: 'expired', reason })
    }
    this.waiters.clear()
  }

  pendingCount(): number {
    return this.listPending().length
  }
}
