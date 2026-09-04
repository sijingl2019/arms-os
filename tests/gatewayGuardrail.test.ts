import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmsBus } from '@main/bus'
import { openDb, type Db } from '@main/db'
import { ConfirmationStore } from '@main/gateway/confirmations'
import {
  audit,
  circuitBreaker,
  compose,
  guardrail,
  rateLimit,
  schemaValidate
} from '@main/gateway/middleware'
import {
  ConfirmationDeniedError,
  GatewayError,
  textResult,
  type CallContext,
  type Middleware,
  type RiskLevel,
  type ToolResult
} from '@main/gateway/types'
import type { PendingConfirmation, ToolCallRecord } from '@shared/types'

let db: Db
let bus: ArmsBus

beforeEach(() => {
  db = openDb(':memory:')
  bus = new ArmsBus()
})

afterEach(() => {
  db.close()
})

function ctx(overrides: Partial<CallContext> = {}): CallContext {
  const risk: RiskLevel = overrides.risk ?? 'read-only'
  return {
    connectorId: 'weibo',
    toolName: 'publish',
    qualifiedName: 'weibo.publish',
    args: {},
    risk,
    runId: null,
    sessionId: null,
    startedAt: new Date(),
    spec: { name: 'publish', description: '', inputSchema: { type: 'object' }, risk },
    ...overrides
  }
}

function run(chain: Middleware[], context: CallContext, handler = async () => textResult('ok')) {
  return compose(chain, handler)(context)
}

describe('compose', () => {
  it('runs middleware outside-in and the handler last', async () => {
    const order: string[] = []
    const mark =
      (name: string): Middleware =>
      async (_c, next) => {
        order.push(`>${name}`)
        const r = await next()
        order.push(`<${name}`)
        return r
      }

    await run([mark('a'), mark('b')], ctx(), async () => {
      order.push('handler')
      return textResult('ok')
    })

    expect(order).toEqual(['>a', '>b', 'handler', '<b', '<a'])
  })

  it('refuses a middleware that calls next twice', async () => {
    const twice: Middleware = async (_c, next) => {
      await next()
      return next()
    }
    await expect(run([twice], ctx())).rejects.toThrow(/more than once/)
  })
})

describe('guardrail', () => {
  function chainFor(risk: RiskLevel, timeoutMs = 50) {
    const confirmations = new ConfirmationStore(db, bus)
    const chain = [guardrail({ confirmations, timeoutMs })]
    return { confirmations, chain, context: ctx({ risk }) }
  }

  it('lets a read-only call straight through', async () => {
    const { chain, context } = chainFor('read-only')
    let called = false
    await run(chain, context, async () => {
      called = true
      return textResult('ok')
    })
    expect(called).toBe(true)
  })

  it('lets a write-reversible call through without asking', async () => {
    const { chain, context, confirmations } = chainFor('write-reversible')
    await run(chain, context)
    expect(confirmations.listPending()).toHaveLength(0)
  })

  it('blocks a write-irreversible call until someone approves', async () => {
    const { chain, context, confirmations } = chainFor('write-irreversible', 5_000)
    let called = false

    const pending: PendingConfirmation[] = []
    bus.on('gateway:confirmation:pending', (e) => pending.push(e))

    const promise = run(chain, context, async () => {
      called = true
      return textResult('published')
    })

    // Still waiting: the downstream must not have run yet.
    await new Promise((r) => setTimeout(r, 10))
    expect(called).toBe(false)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ qualifiedName: 'weibo.publish', status: 'pending' })

    expect(confirmations.approve(pending[0]!.confirmationId)).toBe(true)
    await expect(promise).resolves.toMatchObject({ content: [{ text: 'published' }] })
    expect(called).toBe(true)
  })

  it('never calls the connector when a request is rejected', async () => {
    const { chain, context, confirmations } = chainFor('write-irreversible', 5_000)
    let called = false

    const promise = run(chain, context, async () => {
      called = true
      return textResult('published')
    })
    await new Promise((r) => setTimeout(r, 10))

    const id = confirmations.listPending()[0]!.confirmationId
    confirmations.reject(id, 'not today')

    await expect(promise).rejects.toBeInstanceOf(ConfirmationDeniedError)
    await expect(promise).rejects.toThrow(/not today/)
    expect(called).toBe(false)
  })

  it('expires a request nobody answers, and still does not call the connector', async () => {
    const { chain, context, confirmations } = chainFor('write-irreversible', 30)
    let called = false

    const promise = run(chain, context, async () => {
      called = true
      return textResult('published')
    })

    await expect(promise).rejects.toThrow(/none arrived in time/)
    expect(called).toBe(false)
    expect(confirmations.listPending()).toHaveLength(0)
    expect(confirmations.history()[0]?.status).toBe('expired')
  })

  it('shows the human the exact arguments being approved', async () => {
    const { chain, confirmations } = chainFor('write-irreversible', 5_000)
    void run(chain, ctx({ risk: 'write-irreversible', args: { text: 'hello world' } })).catch(
      () => {}
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(confirmations.listPending()[0]?.args).toEqual({ text: 'hello world' })
  })
})

describe('ConfirmationStore', () => {
  it('refuses to decide the same request twice', async () => {
    const confirmations = new ConfirmationStore(db, bus)
    const promise = confirmations.request({
      connectorId: 'weibo',
      toolName: 'publish',
      qualifiedName: 'weibo.publish',
      args: {},
      risk: 'write-irreversible',
      runId: null,
      timeoutMs: 5_000
    })

    const id = confirmations.listPending()[0]!.confirmationId
    expect(confirmations.approve(id)).toBe(true)
    expect(confirmations.approve(id)).toBe(false)
    expect(confirmations.reject(id, 'too late')).toBe(false)
    await expect(promise).resolves.toMatchObject({ status: 'approved' })
  })

  it('expires rows a previous session left pending', () => {
    const confirmations = new ConfirmationStore(db, bus)
    db.prepare(
      `INSERT INTO confirmations (confirmation_id, connector_id, tool_name, qualified_name,
                                  args, risk, status, requested_at, expires_at)
       VALUES ('old', 'weibo', 'publish', 'weibo.publish', '{}', 'write-irreversible',
               'pending', '2026-09-01T00:00:00Z', '2026-09-01T00:05:00Z')`
    ).run()

    expect(confirmations.expireStale()).toBe(1)
    expect(confirmations.listPending()).toHaveLength(0)
    expect(confirmations.get('old')?.reason).toMatch(/exited/)
  })

  it('releases blocked callers on shutdown instead of hanging them', async () => {
    const confirmations = new ConfirmationStore(db, bus)
    const promise = confirmations.request({
      connectorId: 'weibo',
      toolName: 'publish',
      qualifiedName: 'weibo.publish',
      args: {},
      risk: 'write-irreversible',
      runId: null,
      timeoutMs: 60_000
    })

    confirmations.releaseAll()
    await expect(promise).resolves.toMatchObject({ status: 'expired' })
  })
})

describe('schemaValidate', () => {
  const spec = {
    name: 'publish',
    description: '',
    risk: 'read-only' as RiskLevel,
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' }, draft: { type: 'boolean' } }
    }
  }

  it('rejects a call missing a required argument', async () => {
    await expect(run([schemaValidate], ctx({ spec, args: {} }))).rejects.toThrow(/missing required/)
  })

  it('rejects an argument of the wrong type', async () => {
    await expect(
      run([schemaValidate], ctx({ spec, args: { text: 'hi', draft: 'yes' } }))
    ).rejects.toThrow(/should be boolean/)
  })

  it('accepts a well-formed call', async () => {
    await expect(
      run([schemaValidate], ctx({ spec, args: { text: 'hi', draft: true } }))
    ).resolves.toMatchObject({ content: [{ text: 'ok' }] })
  })
})

describe('rateLimit', () => {
  it('stops a connector past its budget and counts each connector separately', async () => {
    let now = 0
    const chain = [rateLimit({ maxCalls: 2, windowMs: 1000, clock: () => now })]

    await run(chain, ctx())
    await run(chain, ctx())
    await expect(run(chain, ctx())).rejects.toThrow(/exceeded 2 calls/)

    await expect(run(chain, ctx({ connectorId: 'gmail' }))).resolves.toBeTruthy()

    now = 1500
    await expect(run(chain, ctx())).resolves.toBeTruthy()
  })
})

describe('circuitBreaker', () => {
  const boom = async (): Promise<ToolResult> => {
    throw new GatewayError('connector_unavailable', 'down')
  }

  it('opens after repeated failures and closes again after the cooldown', async () => {
    let now = 0
    const chain = [circuitBreaker({ threshold: 2, cooldownMs: 1000, clock: () => now })]

    await expect(run(chain, ctx(), boom)).rejects.toThrow('down')
    await expect(run(chain, ctx(), boom)).rejects.toThrow('down')
    await expect(run(chain, ctx(), boom)).rejects.toThrow(/temporarily disabled/)

    now = 1500
    await expect(run(chain, ctx())).resolves.toBeTruthy()
  })

  it('does not count a rejected approval as a connector failure', async () => {
    const chain = [circuitBreaker({ threshold: 2, cooldownMs: 1000 })]
    const denied = async (): Promise<ToolResult> => {
      throw new ConfirmationDeniedError('rejected')
    }

    await expect(run(chain, ctx(), denied)).rejects.toThrow('rejected')
    await expect(run(chain, ctx(), denied)).rejects.toThrow('rejected')
    // A human saying no says nothing about whether the connector is healthy.
    await expect(run(chain, ctx())).resolves.toBeTruthy()
  })
})

describe('audit', () => {
  function rows(): ToolCallRecord[] {
    return db.prepare('SELECT * FROM tool_calls ORDER BY started_at').all() as never
  }

  it('records a successful call', async () => {
    await run([audit({ db, bus })], ctx(), async () => textResult('done'))
    const all = db.prepare('SELECT outcome, result FROM tool_calls').all() as Array<{
      outcome: string
      result: string
    }>
    expect(all).toEqual([{ outcome: 'succeeded', result: 'done' }])
  })

  it('records a call the guardrail refused - a blocked action is the point of the log', async () => {
    const confirmations = new ConfirmationStore(db, bus)
    const chain = [audit({ db, bus }), guardrail({ confirmations, timeoutMs: 20 })]

    await expect(run(chain, ctx({ risk: 'write-irreversible' }))).rejects.toThrow()

    const all = db.prepare('SELECT outcome, error FROM tool_calls').all() as Array<{
      outcome: string
      error: string
    }>
    expect(all[0]?.outcome).toBe('expired')
    expect(all[0]?.error).toMatch(/none arrived in time/)
  })

  it('records the risk tier and arguments of every call', async () => {
    await run([audit({ db, bus })], ctx({ risk: 'write-reversible', args: { text: 'hi' } }))
    const row = db.prepare('SELECT risk, args FROM tool_calls').get() as {
      risk: string
      args: string
    }
    expect(row.risk).toBe('write-reversible')
    expect(JSON.parse(row.args)).toEqual({ text: 'hi' })
  })

  it('announces each call on the bus', async () => {
    const seen: ToolCallRecord[] = []
    bus.on('gateway:tool:called', (e) => seen.push(e))
    await run([audit({ db, bus })], ctx())
    expect(seen[0]).toMatchObject({ qualifiedName: 'weibo.publish', outcome: 'succeeded' })
    expect(rows()).toHaveLength(1)
  })
})
