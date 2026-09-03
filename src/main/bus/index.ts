import { EventEmitter } from 'node:events'
import type { ArmsEvents } from '@shared/types'

type EventName = keyof ArmsEvents
type Handler<K extends EventName> = (payload: ArmsEvents[K]) => void

/**
 * Typed wrapper over EventEmitter. The main-process modules are decoupled
 * through this (系统设计文档 §5.2) rather than importing one another, which is
 * what lets the Routine Scheduler be bolted on later without touching the
 * Executor.
 */
export class ArmsBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // One bus fans out to the executor, the run log, and later the IPC bridge.
    this.emitter.setMaxListeners(50)
  }

  emit<K extends EventName>(event: K, payload: ArmsEvents[K]): void {
    this.emitter.emit(event, payload)
  }

  /** Returns an unsubscribe function, so callers never need `off` plumbing. */
  on<K extends EventName>(event: K, handler: Handler<K>): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void)
    return () => {
      this.emitter.off(event, handler as (...args: unknown[]) => void)
    }
  }

  removeAll(): void {
    this.emitter.removeAllListeners()
  }
}
