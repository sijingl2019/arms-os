import type { RunStatus } from '@shared/types'
import type { ArmsBus } from '../bus'
import type { Dispatcher } from '../gateway/dispatcher'
import type { RoutineStore } from './store'

/** Cap on the stored result, so one chatty tool cannot bloat the widget table. */
const RESULT_CAP_BYTES = 32_000

export interface ToolRoutineRunnerDeps {
  store: RoutineStore
  dispatcher: Dispatcher
  bus: ArmsBus
}

/**
 * Executes the tool half of `routine:fired`.
 *
 * The Skill Executor handles skill targets; this handles tool targets. Both are
 * subscribers, which is what keeps the scheduler a pure emitter - it never
 * calls either of them, so it can still be lifted out of this process later
 * without anything downstream noticing.
 *
 * The call goes through the Dispatcher rather than an adapter directly, so a
 * scheduled call is governed by exactly the same middleware chain - audit,
 * schema, rate limit, guardrail, breaker - as one an agent makes.
 */
export class ToolRoutineRunner {
  private readonly store: RoutineStore
  private readonly dispatcher: Dispatcher
  private readonly bus: ArmsBus
  private unsubscribe: (() => void) | undefined
  /**
   * Calls started but not awaited by the emitter. Without tracking them, a
   * shutdown closes the database while a tool call is still running and the
   * result is lost - exactly what `RunStore.flush` exists to prevent for the
   * run log.
   */
  private readonly inFlight = new Set<Promise<void>>()

  constructor({ store, dispatcher, bus }: ToolRoutineRunnerDeps) {
    this.store = store
    this.dispatcher = dispatcher
    this.bus = bus
  }

  start(): void {
    this.unsubscribe ??= this.bus.on('routine:fired', (event) => {
      if (event.target.kind !== 'tool') return
      const call = this.run(event.routineId, event.target.toolName, event.target.toolArgs)
      this.inFlight.add(call)
      void call.finally(() => this.inFlight.delete(call))
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /** Wait for every started call to finish. Called on shutdown. */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  /** Exposed for diagnostics and tests. */
  pending(): number {
    return this.inFlight.size
  }

  private async run(
    routineId: string,
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<void> {
    let status: RunStatus = 'succeeded'
    let result: string | null = null
    let error: string | null = null

    try {
      const outcome = await this.dispatcher.call({ qualifiedName: toolName, args: toolArgs })
      const text = outcome.content.map((block) => block.text).join('\n').slice(0, RESULT_CAP_BYTES)
      if (outcome.isError) {
        status = 'failed'
        error = text
      } else {
        result = text
      }
    } catch (err) {
      status = 'failed'
      error = (err as Error).message
    }

    // Save before announcing, so a widget woken by the event reads the new
    // value rather than the previous one.
    this.store.saveResult(routineId, status, result, error)
    this.bus.emit('routine:tool:completed', { routineId, status, result, error })
    this.bus.emit('routines:updated', { routineId })
  }
}
