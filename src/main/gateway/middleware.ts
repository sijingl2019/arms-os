import { randomUUID } from 'node:crypto'
import type { ToolCallOutcome, ToolCallRecord } from '@shared/types'
import type { ArmsBus } from '../bus'
import type { Db } from '../db'
import type { ConfirmationStore } from './confirmations'
import {
  ConfirmationDeniedError,
  GatewayError,
  type CallContext,
  type Middleware,
  type ToolResult
} from './types'

/**
 * The middleware chain (Connector Gateway 设计文档 §2.1). Order is declared
 * once, in `buildChain`, so adding a stage never means touching the others.
 */

/** Compose Koa-style middleware around a terminal handler. */
export function compose(chain: Middleware[], handler: (ctx: CallContext) => Promise<ToolResult>) {
  return (ctx: CallContext): Promise<ToolResult> => {
    let index = -1
    const step = (i: number): Promise<ToolResult> => {
      // Guards the classic composition bug: a middleware that awaits next()
      // twice would otherwise run the rest of the chain - and the call - twice.
      if (i <= index) return Promise.reject(new Error('next() called more than once'))
      index = i
      const mw = chain[i]
      if (!mw) return handler(ctx)
      return mw(ctx, () => step(i + 1))
    }
    return step(0)
  }
}

/**
 * Shallow JSON Schema check: required keys present, primitive types match.
 *
 * Deliberately not a full validator. Its job is to stop obviously malformed
 * calls before they reach a connector; the connector remains responsible for
 * its own input, and a partial check must never be mistaken for a security
 * boundary - that is what the guardrail is for.
 */
export const schemaValidate: Middleware = async (ctx, next) => {
  const schema = ctx.spec.inputSchema
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : []
  const missing = required
    .filter((key): key is string => typeof key === 'string')
    .filter((key) => ctx.args[key] === undefined)

  if (missing.length > 0) {
    throw new GatewayError(
      'invalid_arguments',
      `${ctx.qualifiedName} is missing required argument(s): ${missing.join(', ')}`
    )
  }

  const properties = schema['properties']
  if (typeof properties === 'object' && properties !== null) {
    for (const [key, value] of Object.entries(ctx.args)) {
      const prop = (properties as Record<string, unknown>)[key]
      if (typeof prop !== 'object' || prop === null) continue
      const expected = (prop as Record<string, unknown>)['type']
      if (typeof expected !== 'string') continue
      if (!matchesType(value, expected)) {
        throw new GatewayError(
          'invalid_arguments',
          `${ctx.qualifiedName}: argument "${key}" should be ${expected}`
        )
      }
    }
  }

  return next()
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string':
      return typeof value === 'string'
    case 'number':
    case 'integer':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'null':
      return value === null
    default:
      return true
  }
}

export interface GuardrailOptions {
  confirmations: ConfirmationStore
  /** How long a blocked call waits for a human. */
  timeoutMs: number
}

/**
 * The single enforcement point (§2.3, §4).
 *
 * `read-only` passes. `write-reversible` passes but is marked in the audit
 * trail. `write-irreversible` does not run until a human approves it - and
 * because an unlabelled tool is already resolved to the strictest tier
 * upstream, forgetting to label something makes the system ask more, not less.
 */
export function guardrail({ confirmations, timeoutMs }: GuardrailOptions): Middleware {
  return async (ctx, next) => {
    if (ctx.risk !== 'write-irreversible') return next()

    const decision = await confirmations.request({
      connectorId: ctx.connectorId,
      toolName: ctx.toolName,
      qualifiedName: ctx.qualifiedName,
      args: ctx.args,
      risk: ctx.risk,
      runId: ctx.runId,
      timeoutMs
    })

    if (decision.status !== 'approved') {
      throw new ConfirmationDeniedError(
        decision.status === 'expired'
          ? `${ctx.qualifiedName} needed human approval and none arrived in time`
          : `${ctx.qualifiedName} was rejected${decision.reason ? `: ${decision.reason}` : ''}`
      )
    }

    return next()
  }
}

export interface RateLimitOptions {
  /** Max calls per connector inside the window. */
  maxCalls: number
  windowMs: number
  clock?: () => number
}

/** Cheap fixed-window limiter, per connector (§1.1 limits and cost control). */
export function rateLimit({ maxCalls, windowMs, clock }: RateLimitOptions): Middleware {
  const now = clock ?? (() => Date.now())
  const hits = new Map<string, number[]>()

  return async (ctx, next) => {
    const at = now()
    const recent = (hits.get(ctx.connectorId) ?? []).filter((t) => at - t < windowMs)
    if (recent.length >= maxCalls) {
      throw new GatewayError(
        'rate_limited',
        `${ctx.connectorId} exceeded ${maxCalls} calls per ${Math.round(windowMs / 1000)}s`
      )
    }
    recent.push(at)
    hits.set(ctx.connectorId, recent)
    return next()
  }
}

export interface AuditOptions {
  db: Db
  bus: ArmsBus
  /** Cap on the stored result text, mirroring the run output cap. */
  resultCapBytes?: number
}

function outcomeFor(err: unknown): ToolCallOutcome {
  if (err instanceof ConfirmationDeniedError) {
    return err.message.includes('none arrived in time') ? 'expired' : 'denied'
  }
  if (err instanceof GatewayError) {
    if (err.code === 'connector_timeout') return 'timeout'
    if (err.code === 'rate_limited' || err.code === 'invalid_arguments') return 'blocked'
  }
  return 'failed'
}

/**
 * Writes one row per call, whatever the outcome - including calls the guardrail
 * refused. An action that was stopped is exactly the thing you want in the log.
 */
export function audit({ db, bus, resultCapBytes = 8_000 }: AuditOptions): Middleware {
  const insert = db.prepare(
    `INSERT INTO tool_calls (call_id, connector_id, tool_name, qualified_name, args, risk,
                             outcome, confirmation_id, run_id, session_id, started_at,
                             ended_at, duration_ms, result, error)
     VALUES (@call_id, @connector_id, @tool_name, @qualified_name, @args, @risk,
             @outcome, @confirmation_id, @run_id, @session_id, @started_at,
             @ended_at, @duration_ms, @result, @error)`
  )

  return async (ctx, next) => {
    const callId = randomUUID()
    const started = ctx.startedAt

    const write = (outcome: ToolCallOutcome, result: string | null, error: string | null): void => {
      const endedAt = new Date()
      const record: ToolCallRecord = {
        callId,
        connectorId: ctx.connectorId,
        toolName: ctx.toolName,
        qualifiedName: ctx.qualifiedName,
        args: ctx.args,
        risk: ctx.risk,
        outcome,
        confirmationId: ctx.confirmationId ?? null,
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        startedAt: started.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - started.getTime(),
        result: result === null ? null : result.slice(0, resultCapBytes),
        error
      }
      insert.run({
        call_id: record.callId,
        connector_id: record.connectorId,
        tool_name: record.toolName,
        qualified_name: record.qualifiedName,
        args: JSON.stringify(record.args),
        risk: record.risk,
        outcome: record.outcome,
        confirmation_id: record.confirmationId,
        run_id: record.runId,
        session_id: record.sessionId,
        started_at: record.startedAt,
        ended_at: record.endedAt,
        duration_ms: record.durationMs,
        result: record.result,
        error: record.error
      })
      bus.emit('gateway:tool:called', record)
    }

    try {
      const result = await next()
      const text = result.content.map((c) => c.text).join('\n')
      write(result.isError === true ? 'failed' : 'succeeded', text, null)
      return result
    } catch (err) {
      write(outcomeFor(err), null, (err as Error).message)
      throw err
    }
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before the connector is shut out. */
  threshold: number
  /** How long it stays shut out. */
  cooldownMs: number
  clock?: () => number
}

/**
 * Keeps one broken connector from being retried into the ground (§7). Trips per
 * connector, so a dead Gmail server never stops the local CLI connectors.
 */
export function circuitBreaker({ threshold, cooldownMs, clock }: CircuitBreakerOptions): Middleware {
  const now = clock ?? (() => Date.now())
  const failures = new Map<string, number>()
  const openedAt = new Map<string, number>()

  return async (ctx, next) => {
    const opened = openedAt.get(ctx.connectorId)
    if (opened !== undefined) {
      if (now() - opened < cooldownMs) {
        throw new GatewayError(
          'circuit_open',
          `${ctx.connectorId} is temporarily disabled after repeated failures`
        )
      }
      openedAt.delete(ctx.connectorId)
      failures.delete(ctx.connectorId)
    }

    try {
      const result = await next()
      failures.delete(ctx.connectorId)
      return result
    } catch (err) {
      // A refused or malformed call says nothing about the connector's health.
      if (err instanceof ConfirmationDeniedError) throw err
      if (err instanceof GatewayError && (err.code === 'invalid_arguments' || err.code === 'rate_limited')) {
        throw err
      }

      const count = (failures.get(ctx.connectorId) ?? 0) + 1
      failures.set(ctx.connectorId, count)
      if (count >= threshold) openedAt.set(ctx.connectorId, now())
      throw err
    }
  }
}
