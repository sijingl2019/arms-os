import type {
  RoutineDef,
  RoutineSkipReason,
  RoutineStartupReport,
  RoutineTarget,
  RunStatus
} from '@shared/types'
import type { ArmsBus } from '../bus'
import type { RoutineStore } from './store'

/**
 * How often the loop asks "what is due". A tick, rather than one timer per
 * routine, because timers drift, do not survive a laptop sleeping through a
 * trigger, and cannot express "this became due while we were suspended".
 * Comparing a persisted `next_run_at` against the wall clock handles all three.
 */
const DEFAULT_TICK_MS = 20_000

export interface RoutineSchedulerDeps {
  store: RoutineStore
  bus: ArmsBus
  /**
   * Decide whether a target may fire right now. Returns a skip reason, or null
   * to proceed.
   *
   * Asked at every firing, not only at creation: a tool that was safe to
   * schedule can be promoted to write-irreversible by an edit to the connector
   * manifest, and a routine must not go on firing into a guardrail that will
   * block it, time out, and leave a trail of expired approvals nobody saw.
   */
  checkTarget(target: RoutineTarget): RoutineSkipReason | null
  tickMs?: number
  /**
   * Source of "now" for everything the scheduler does, including the retry
   * clock. Injectable so tests are not partly driven by the wall clock while
   * the rest of their timeline is fixed.
   */
  clock?: () => Date
}

export interface TickResult {
  fired: string[]
  skipped: Array<{ routineId: string; reason: RoutineSkipReason }>
  retried: string[]
}

interface PendingRetry {
  routineId: string
  attempt: number
  dueAt: number
}

/**
 * Turns persisted cron schedules into `routine:fired` events (系统设计文档
 * §6.2 场景 B).
 *
 * It never touches an agent or a connector: it only emits, and the Skill
 * Executor - already subscribed - does the work. That indirection is what lets
 * this module be swapped for an out-of-process scheduler later without the
 * executor noticing.
 */
export class RoutineScheduler {
  private readonly store: RoutineStore
  private readonly bus: ArmsBus
  private readonly checkTarget: (target: RoutineTarget) => RoutineSkipReason | null
  private readonly tickMs: number
  private readonly clock: () => Date

  private timer: NodeJS.Timeout | undefined
  private unsubscribe: (() => void) | undefined
  /** routineId -> attempt, for runs this scheduler started and is awaiting. */
  private readonly inFlight = new Map<string, number>()
  private retries: PendingRetry[] = []

  constructor({ store, bus, checkTarget, tickMs, clock }: RoutineSchedulerDeps) {
    this.store = store
    this.bus = bus
    this.checkTarget = checkTarget
    this.tickMs = tickMs ?? DEFAULT_TICK_MS
    this.clock = clock ?? (() => new Date())
  }

  /**
   * Reconcile schedules missed while the process was down, then begin ticking.
   * Returns what the reconciliation did so the caller can surface it.
   */
  start(now = this.clock()): RoutineStartupReport {
    const report = this.reconcile(now)

    // Two completion paths, one handler: a skill target reports through the
    // run record, a tool target has no run record to report through.
    this.unsubscribe ??= (() => {
      const offRun = this.bus.on('skill:run:completed', (event) => {
        if (!event.routineId) return
        this.onRunCompleted(event.routineId, event.runId, event.status)
      })
      const offTool = this.bus.on('routine:tool:completed', (event) => {
        this.onRunCompleted(event.routineId, null, event.status)
      })
      return () => {
        offRun()
        offTool()
      }
    })()

    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.tickMs)
      // Never hold the process open just to keep ticking.
      this.timer.unref?.()
    }

    return report
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.inFlight.clear()
    this.retries = []
  }

  /**
   * One pass of the loop. Public so tests can drive it with an explicit clock
   * instead of waiting on real time.
   */
  tick(now = this.clock()): TickResult {
    const result: TickResult = { fired: [], skipped: [], retried: [] }

    for (const retry of this.takeDueRetries(now)) {
      const routine = this.store.get(retry.routineId)
      if (!routine || !routine.enabled) continue
      if (this.fire(routine, now, retry.attempt)) result.retried.push(routine.id)
    }

    for (const routine of this.store.due(now)) {
      const outcome = this.fireScheduled(routine, now)
      if (outcome === null) result.fired.push(routine.id)
      else result.skipped.push({ routineId: routine.id, reason: outcome })
      // Advance regardless: a skipped occurrence must not be retried forever.
      this.store.reschedule(routine.id, now)
    }

    if (result.fired.length + result.skipped.length + result.retried.length > 0) {
      this.bus.emit('routines:updated', { routineId: null })
    }
    return result
  }

  /**
   * Decide what a missed schedule means. Anything still due at startup came due
   * while the process was down, since a running loop would have consumed it.
   */
  private reconcile(now: Date): RoutineStartupReport {
    const all = this.store.list()
    const report: RoutineStartupReport = {
      loaded: all.length,
      missed: 0,
      caughtUp: 0,
      skipped: 0
    }

    for (const routine of all) {
      if (!routine.enabled) {
        if (routine.nextRunAt !== null) this.store.reschedule(routine.id, now)
        continue
      }

      if (routine.nextRunAt === null) {
        this.store.reschedule(routine.id, now)
        continue
      }

      if (new Date(routine.nextRunAt).getTime() > now.getTime()) continue

      report.missed += 1
      if (routine.missedRunPolicy === 'catch-up-once' && this.fire(routine, now, 1)) {
        report.caughtUp += 1
      } else {
        report.skipped += 1
        this.skip(routine, 'missed-while-offline', now)
      }
      this.store.reschedule(routine.id, now)
    }

    if (report.missed > 0) this.bus.emit('routines:updated', { routineId: null })
    return report
  }

  /** null when fired; otherwise why it was skipped. */
  private fireScheduled(routine: RoutineDef, now: Date): RoutineSkipReason | null {
    if (this.inFlight.has(routine.id)) {
      // 架构规范 §6.2 idempotency: a routine that is still running must not be
      // started again on top of itself.
      this.skip(routine, 'previous-run-still-active', now)
      return 'previous-run-still-active'
    }
    const problem = this.checkTarget(routine.target)
    if (problem) {
      this.skip(routine, problem, now)
      return problem
    }
    this.fire(routine, now, 1)
    return null
  }

  private fire(routine: RoutineDef, now: Date, attempt: number): boolean {
    const problem = this.checkTarget(routine.target)
    if (problem) {
      this.skip(routine, problem, now)
      return false
    }

    this.inFlight.set(routine.id, attempt)
    this.store.markFired(routine.id, now, null)
    this.bus.emit('routine:fired', {
      routineId: routine.id,
      target: routine.target,
      attempt
    })
    return true
  }

  private skip(routine: RoutineDef, reason: RoutineSkipReason, now: Date): void {
    this.store.markStatus(routine.id, 'skipped', now)
    this.bus.emit('routine:skipped', {
      routineId: routine.id,
      reason,
      at: now.toISOString()
    })
  }

  private onRunCompleted(routineId: string, runId: string | null, status: RunStatus): void {
    const attempt = this.inFlight.get(routineId) ?? 1
    this.inFlight.delete(routineId)

    const now = this.clock()
    this.store.markStatus(routineId, status, now, runId)

    const routine = this.store.get(routineId)
    if (routine && status !== 'succeeded' && attempt <= routine.maxRetries) {
      this.retries.push({
        routineId,
        attempt: attempt + 1,
        dueAt: now.getTime() + routine.retryDelayMs
      })
    }

    this.bus.emit('routines:updated', { routineId })
  }

  private takeDueRetries(now: Date): PendingRetry[] {
    const due = this.retries.filter((r) => r.dueAt <= now.getTime())
    if (due.length > 0) this.retries = this.retries.filter((r) => r.dueAt > now.getTime())
    return due
  }

  /** Exposed for diagnostics and tests; retries live in memory only. */
  pendingRetries(): number {
    return this.retries.length
  }
}
