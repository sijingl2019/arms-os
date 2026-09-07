import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmsBus } from '@main/bus'
import { openDb, type Db } from '@main/db'
import type { RiskLevel, ToolResult } from '@main/gateway/types'
import { textResult } from '@main/gateway/types'
import { RoutineScheduler } from '@main/routines/scheduler'
import { RoutineStore, RoutineValidationError } from '@main/routines/store'
import { checkRoutineTarget, explainTargetProblem } from '@main/routines/target'
import { ToolRoutineRunner } from '@main/routines/toolRunner'
import type { ArmsEvents, RoutineTargetInput } from '@shared/types'

/**
 * Routines that call a Gateway tool instead of a Skill - the mechanism behind
 * a declarative widget. The rules that matter here are about what a schedule is
 * allowed to reach, and where its output is allowed to live.
 */

const AT = (iso: string): Date => new Date(iso)
const DAILY_9 = '0 9 * * *'

let db: Db
let bus: ArmsBus
/** Tool name -> risk, standing in for the connector manifest. */
let tools: Map<string, RiskLevel>
let skills: Set<string>
let store: RoutineStore

const resolvers = {
  hasSkill: (id: string) => skills.has(id),
  riskOfTool: (name: string) => tools.get(name)
}

function newStore(): RoutineStore {
  return new RoutineStore(db, (target) => {
    const problem = checkRoutineTarget(target, resolvers)
    return problem ? explainTargetProblem(problem, target) : null
  })
}

function makeTool(
  target: Partial<Extract<RoutineTargetInput, { kind: 'tool' }>> = {},
  cron = DAILY_9
) {
  return store.create(
    {
      name: 'inbox widget',
      target: { kind: 'tool', toolName: 'email.list_unread', toolArgs: {}, ...target },
      cron,
      timezone: 'UTC'
    },
    AT('2026-09-04T08:00:00Z')
  )
}

beforeEach(() => {
  db = openDb(':memory:')
  bus = new ArmsBus()
  tools = new Map<string, RiskLevel>([
    ['email.list_unread', 'read-only'],
    ['email.mark_read', 'write-reversible'],
    ['email.delete', 'write-irreversible']
  ])
  skills = new Set(['news-digest'])
  store = newStore()
})

afterEach(() => {
  db.close()
})

describe('what a routine may target', () => {
  it('accepts a read-only tool', () => {
    expect(makeTool().target).toEqual({
      kind: 'tool',
      toolName: 'email.list_unread',
      toolArgs: {}
    })
  })

  it('accepts a reversible write', () => {
    expect(() => makeTool({ toolName: 'email.mark_read' })).not.toThrow()
  })

  it('refuses an irreversible tool at creation', () => {
    // A schedule cannot answer an approval prompt at 3am, so it would only ever
    // block and expire. Refusing is both safer and more honest.
    expect(() => makeTool({ toolName: 'email.delete' })).toThrow(RoutineValidationError)
    expect(() => makeTool({ toolName: 'email.delete' })).toThrow(/不可逆/)
    expect(store.list()).toHaveLength(0)
  })

  it('points the user at Skills instead of just saying no', () => {
    expect(() => makeTool({ toolName: 'email.delete' })).toThrow(/Skill/)
  })

  it('refuses a tool the Gateway does not expose', () => {
    expect(() => makeTool({ toolName: 'email.telepathy' })).toThrow(/没有这个 tool/)
  })

  it('refuses an unqualified tool name', () => {
    expect(() => makeTool({ toolName: 'list_unread' })).toThrow(/connector/)
  })

  it('still refuses an unknown skill', () => {
    expect(() =>
      store.create({
        name: 'x',
        target: { kind: 'skill', skillId: 'nope' },
        cron: DAILY_9
      })
    ).toThrow(/未知 Skill/)
  })

  it('replaces the target wholesale on update rather than merging kinds', () => {
    const routine = makeTool()
    const updated = store.update(routine.id, {
      target: { kind: 'skill', skillId: 'news-digest' }
    })
    expect(updated.target).toMatchObject({ kind: 'skill', skillId: 'news-digest' })
  })

  it('round-trips tool arguments through the database', () => {
    const routine = makeTool({ toolArgs: { folder: 'INBOX', limit: 10 } })
    expect(store.get(routine.id)?.target).toEqual({
      kind: 'tool',
      toolName: 'email.list_unread',
      toolArgs: { folder: 'INBOX', limit: 10 }
    })
  })
})

describe('risk is re-checked at fire time, not trusted from creation', () => {
  let fired: ArmsEvents['routine:fired'][]
  let skipped: ArmsEvents['routine:skipped'][]
  let scheduler: RoutineScheduler

  beforeEach(() => {
    fired = []
    skipped = []
    bus.on('routine:fired', (e) => fired.push(e))
    bus.on('routine:skipped', (e) => skipped.push(e))
    scheduler = new RoutineScheduler({
      store,
      bus,
      checkTarget: (target) => checkRoutineTarget(target, resolvers)
    })
  })

  afterEach(() => scheduler.stop())

  it('fires a tool routine that is still safe', () => {
    const routine = makeTool()
    const result = scheduler.tick(AT('2026-09-04T09:00:01Z'))

    expect(result.fired).toEqual([routine.id])
    expect(fired[0]?.target).toEqual({
      kind: 'tool',
      toolName: 'email.list_unread',
      toolArgs: {}
    })
  })

  it('stops firing when the manifest promotes the tool to irreversible', () => {
    const routine = makeTool()

    // The manifest is a file the user edits; a routine saved when the tool was
    // read-only must not go on firing into a guardrail that will now block it.
    tools.set('email.list_unread', 'write-irreversible')

    const result = scheduler.tick(AT('2026-09-04T09:00:01Z'))
    expect(result.skipped).toEqual([{ routineId: routine.id, reason: 'tool-risk-raised' }])
    expect(fired).toHaveLength(0)
    expect(skipped[0]?.reason).toBe('tool-risk-raised')
  })

  it('stops firing when the tool disappears from the manifest', () => {
    const routine = makeTool()
    tools.delete('email.list_unread')

    const result = scheduler.tick(AT('2026-09-04T09:00:01Z'))
    expect(result.skipped).toEqual([{ routineId: routine.id, reason: 'unknown-tool' }])
  })

  it('advances the schedule even when it skipped, so it does not re-skip forever', () => {
    const routine = makeTool()
    tools.delete('email.list_unread')
    scheduler.tick(AT('2026-09-04T09:00:01Z'))
    expect(store.get(routine.id)?.nextRunAt).toBe('2026-09-05T09:00:00.000Z')
  })
})

describe('ToolRoutineRunner', () => {
  let runner: ToolRoutineRunner
  let calls: Array<{ qualifiedName: string; args: Record<string, unknown> }>
  let reply: () => Promise<ToolResult>

  function dispatcher() {
    return {
      call: async (req: { qualifiedName: string; args: Record<string, unknown> }) => {
        calls.push(req)
        return reply()
      }
    } as unknown as ConstructorParameters<typeof ToolRoutineRunner>[0]['dispatcher']
  }

  beforeEach(() => {
    calls = []
    reply = async () => textResult('12 unread')
    runner = new ToolRoutineRunner({ store, dispatcher: dispatcher(), bus })
    runner.start()
  })

  afterEach(() => runner.stop())

  async function fire(routineId: string, toolName = 'email.list_unread'): Promise<void> {
    bus.emit('routine:fired', {
      routineId,
      target: { kind: 'tool', toolName, toolArgs: { folder: 'INBOX' } },
      attempt: 1
    })
    await new Promise((resolve) => setImmediate(resolve))
  }

  it('calls the tool through the dispatcher, so the middleware chain still applies', async () => {
    const routine = makeTool()
    await fire(routine.id)

    expect(calls).toEqual([
      { qualifiedName: 'email.list_unread', args: { folder: 'INBOX' } }
    ])
  })

  it('ignores a skill target, which belongs to the Executor', async () => {
    bus.emit('routine:fired', {
      routineId: 'r1',
      target: { kind: 'skill', skillId: 'news-digest', args: null, agent: null, model: null, effort: null },
      attempt: 1
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toHaveLength(0)
  })

  it('stores the latest value where a widget can read it', async () => {
    const routine = makeTool()
    await fire(routine.id)

    expect(store.result(routine.id)).toMatchObject({
      status: 'succeeded',
      result: '12 unread',
      error: null
    })
  })

  it('keeps only the latest value, so the table cannot grow', async () => {
    const routine = makeTool()
    await fire(routine.id)
    reply = async () => textResult('3 unread')
    await fire(routine.id)

    expect(store.results()).toHaveLength(1)
    expect(store.result(routine.id)?.result).toBe('3 unread')
  })

  it('records a tool error rather than losing it', async () => {
    const routine = makeTool()
    reply = async () => textResult('IMAP login failed', true)
    await fire(routine.id)

    expect(store.result(routine.id)).toMatchObject({
      status: 'failed',
      result: null,
      error: 'IMAP login failed'
    })
  })

  it('survives a dispatcher that throws', async () => {
    const routine = makeTool()
    reply = async () => {
      throw new Error('circuit open')
    }
    await fire(routine.id)

    expect(store.result(routine.id)).toMatchObject({ status: 'failed', error: 'circuit open' })
  })

  it('announces completion so the scheduler can release its in-flight guard', async () => {
    const routine = makeTool()
    const done: ArmsEvents['routine:tool:completed'][] = []
    bus.on('routine:tool:completed', (e) => done.push(e))

    await fire(routine.id)
    expect(done[0]).toMatchObject({ routineId: routine.id, status: 'succeeded' })
  })

  it('saves before announcing, so a widget woken by the event reads the new value', async () => {
    const routine = makeTool()
    let seen: string | null | undefined
    bus.on('routine:tool:completed', () => {
      seen = store.result(routine.id)?.result
    })

    await fire(routine.id)
    expect(seen).toBe('12 unread')
  })

  it('can be drained on shutdown, so a call in flight is not lost', async () => {
    const routine = makeTool()
    let release: (() => void) | undefined
    reply = () =>
      new Promise<ToolResult>((resolve) => {
        release = () => resolve(textResult('late but saved'))
      })

    bus.emit('routine:fired', {
      routineId: routine.id,
      target: { kind: 'tool', toolName: 'email.list_unread', toolArgs: {} },
      attempt: 1
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(runner.pending()).toBe(1)

    release?.()
    await runner.flush()

    expect(runner.pending()).toBe(0)
    expect(store.result(routine.id)?.result).toBe('late but saved')
  })

  it('lets the next firing through once the previous one reported back', async () => {
    const routine = makeTool({}, '*/5 * * * *')
    const scheduler = new RoutineScheduler({
      store,
      bus,
      checkTarget: (target) => checkRoutineTarget(target, resolvers)
    })
    scheduler.start(AT('2026-09-04T08:59:00Z'))

    scheduler.tick(AT('2026-09-04T09:00:01Z'))
    await new Promise((resolve) => setImmediate(resolve))
    // The runner has reported, so the in-flight guard is clear.
    const second = scheduler.tick(AT('2026-09-04T09:05:01Z'))

    expect(second.fired).toEqual([routine.id])
    expect(calls).toHaveLength(2)
    scheduler.stop()
  })
})

describe('routine_results lifecycle', () => {
  it('is removed with its routine', () => {
    const routine = makeTool()
    store.saveResult(routine.id, 'succeeded', 'x', null)
    expect(store.result(routine.id)).toBeDefined()

    store.remove(routine.id)
    expect(store.result(routine.id)).toBeUndefined()
  })
})
