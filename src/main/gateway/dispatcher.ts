import type { ArmsBus } from '../bus'
import type { Db } from '../db'
import type { ConfirmationStore } from './confirmations'
import {
  audit,
  circuitBreaker,
  compose,
  guardrail,
  rateLimit,
  schemaValidate
} from './middleware'
import type { ConnectorRegistry } from './registry'
import type { CallContext, Middleware, ToolResult } from './types'

export interface DispatcherOptions {
  registry: ConnectorRegistry
  confirmations: ConfirmationStore
  db: Db
  bus: ArmsBus
  /** How long a write-irreversible call waits for a human. */
  confirmationTimeoutMs: number
  rateLimit?: { maxCalls: number; windowMs: number }
  circuitBreaker?: { threshold: number; cooldownMs: number }
}

export interface DispatchRequest {
  qualifiedName: string
  args: Record<string, unknown>
  runId?: string | null
  sessionId?: string | null
}

/**
 * The front controller (Connector Gateway 设计文档 §2.1): resolve the tool,
 * run the middleware chain, hand off to the adapter.
 *
 * The chain order is the security story, so it is declared in exactly one
 * place. Audit sits near the outside deliberately - it must record calls the
 * guardrail refuses, which means it has to wrap the guardrail, not follow it.
 */
export class Dispatcher {
  private readonly registry: ConnectorRegistry
  private readonly chain: Middleware[]

  constructor(options: DispatcherOptions) {
    this.registry = options.registry

    const limits = options.rateLimit ?? { maxCalls: 60, windowMs: 60_000 }
    const breaker = options.circuitBreaker ?? { threshold: 5, cooldownMs: 60_000 }

    this.chain = [
      audit({ db: options.db, bus: options.bus }),
      schemaValidate,
      rateLimit(limits),
      guardrail({
        confirmations: options.confirmations,
        timeoutMs: options.confirmationTimeoutMs
      }),
      circuitBreaker(breaker)
    ]
  }

  async call(req: DispatchRequest): Promise<ToolResult> {
    const { state, tool } = this.registry.resolve(req.qualifiedName)

    const ctx: CallContext = {
      connectorId: tool.connectorId,
      toolName: tool.name,
      qualifiedName: tool.qualifiedName,
      args: req.args,
      risk: tool.risk,
      runId: req.runId ?? null,
      sessionId: req.sessionId ?? null,
      startedAt: new Date(),
      spec: tool
    }

    const run = compose(this.chain, (finalCtx) =>
      state.adapter.callTool(finalCtx.toolName, finalCtx.args, finalCtx)
    )

    return run(ctx)
  }
}
