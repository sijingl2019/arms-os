import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmsBus } from '@main/bus'
import { RoutineScheduler } from '@main/routines/scheduler'
import { RoutineStore, RoutineValidationError, validateRoutine } from '@main/routines/store'
import type { ArmsEvents, RoutineInput, RoutineTargetInput } from '@shared/types'
import { createHarness, type Harness } from './helpers'

const AT = (iso: string): Date => new Date(iso)
/** 09:00 UTC daily - the shape of a "morning digest" routine. */
const DAILY_9 = '0 9 * * *'

let h: Harness
let store: RoutineStore
let bus: ArmsBus

/** A skill target, unless the test overrides it. */
const SKILL_TARGET: RoutineTargetInput = { kind: 'skill', skillId: 'news-digest' }

function make(overrides: Partial<RoutineInput> = {}, now = AT('2026-09-04T08:00:00Z')) {
  return store.create(
    {
      name: 'morning digest',
      target: SKILL_TARGET,
      cron: DAILY_9,
      timezone: 'UTC',
      ...overrides
    },
    now
  )
}

beforeEach(() => {
  h = createHarness()
  store = new RoutineStore(h.db)
  bus = new ArmsBus()
})

afterEach(() => {
  h.db.close()
  h.cleanup()
})

describe('validateRoutine', () => {
  const base: RoutineInput = {
    name: 'r',
    target: { kind: 'skill', skillId: 's' },
    cron: DAILY_9
  }

  it('accepts a well-formed routine', () => {
    expect(validateRoutine(base)).toEqual([])
  })

  it.each([
    ['name', { ...base, name: '  ' }],
    ['target', { ...base, target: { kind: 'skill', skillId: '' } }],
    ['cron', { ...base, cron: 'not a cron' }],
    ['maxRetries', { ...base, maxRetries: -1 }],
    ['retryDelayMs', { ...base, retryDelayMs: -5 }]
  ])('rejects a bad %s', (field, input) => {
    expect(validateRoutine(input as RoutineInput).map((i) => i.field)).toContain(field)
  })

  it('rejects an unknown timezone', () => {
    expect(validateRoutine({ ...base, timezone: 'Mars/Olympus' }).length).toBeGreaterThan(0)
  })
})

describe('RoutineStore', () => {
  it('computes next_run_at on create', () => {
    const routine = make()
    expect(routine.nextRunAt).toBe('2026-09-04T09:00:00.000Z')
  })

  it('honours the timezone when computing the next run', () => {
    const routine = make({ timezone: 'Asia/Shanghai' })
    // 09:00 in Shanghai is 01:00 UTC, which has already passed at 08:00 UTC.
    expect(routine.nextRunAt).toBe('2026-09-05T01:00:00.000Z')
  })

  it('refuses to store an invalid cron rather than failing at tick time', () => {
    expect(() => make({ cron: 'every morning' })).toThrow(RoutineValidationError)
    expect(store.list()).toHaveLength(0)
  })

  it('leaves a disabled routine with no due time', () => {
    expect(make({ enabled: false }).nextRunAt).toBeNull()
  })

  it('applies the documented defaults', () => {
    const routine = make()
    expect(routine).toMatchObject({ missedRunPolicy: 'skip', maxRetries: 0, enabled: true })
  })

  it('recomputes the due time when the schedule changes', () => {
    const routine = make()
    const updated = store.update(routine.id, { cron: '30 10 * * *' }, AT('2026-09-04T08:30:00Z'))
    expect(updated.nextRunAt).toBe('2026-09-04T10:30:00.000Z')
  })

  it('keeps the due time when an unrelated field changes', () => {
    const routine = make()
    const updated = store.update(routine.id, { name: 'renamed' }, AT('2026-09-04T08:30:00Z'))
    expect(updated.nextRunAt).toBe(routine.nextRunAt)
    expect(updated.name).toBe('renamed')
  })

  it('clears the due time on disable and restores it on re-enable', () => {
    const routine = make()
    expect(store.update(routine.id, { enabled: false }, AT('2026-09-04T08:30:00Z')).nextRunAt).toBeNull()
    const back = store.update(routine.id, { enabled: true }, AT('2026-09-04T08:30:00Z'))
    expect(back.nextRunAt).toBe('2026-09-04T09:00:00.000Z')
  })

  it('rejects an invalid patch without corrupting the stored routine', () => {
    const routine = make()
    expect(() => store.update(routine.id, { cron: 'nope' })).toThrow(RoutineValidationError)
    expect(store.get(routine.id)?.cron).toBe(DAILY_9)
  })

  it('returns only enabled routines that are actually due', () => {
    const due = make({ name: 'due' })
    make({ name: 'later', cron: '0 23 * * *' })
    make({ name: 'off', enabled: false })

    const list = store.due(AT('2026-09-04T09:00:01Z'))
    expect(list.map((r) => r.id)).toEqual([due.id])
  })

  it('advances strictly past the given instant, so a firing cannot repeat', () => {
    const routine = make()
    const next = store.reschedule(routine.id, AT('2026-09-04T09:00:00.000Z'))
    expect(next).toBe('2026-09-05T09:00:00.000Z')
  })

  it('deletes', () => {
    const routine = make()
    expect(store.remove(routine.id)).toBe(true)
    expect(store.remove(routine.id)).toBe(false)
  })
})

describe('RoutineScheduler', () => {
  let fired: ArmsEvents['routine:fired'][]
  let skipped: ArmsEvents['routine:skipped'][]
  let known: Set<string>
  let scheduler: RoutineScheduler

  beforeEach(() => {
    fired = []
    skipped = []
    known = new Set(['news-digest'])
    bus.on('routine:fired', (e) => fired.push(e))
    bus.on('routine:skipped', (e) => skipped.push(e))
    scheduler = new RoutineScheduler({
      store,
      bus,
      checkTarget: (target) =>
        target.kind === 'skill' && known.has(target.skillId) ? null : 'unknown-skill'
    })
  })

  afterEach(() => scheduler.stop())

  it('fires a due routine and advances its schedule', () => {
    const routine = make()
    const result = scheduler.tick(AT('2026-09-04T09:00:01Z'))

    expect(result.fired).toEqual([routine.id])
    expect(fired[0]).toMatchObject({ routineId: routine.id, attempt: 1 })
    expect(fired[0]?.target).toMatchObject({ kind: 'skill', skillId: 'news-digest' })
    expect(store.get(routine.id)?.nextRunAt).toBe('2026-09-05T09:00:00.000Z')
  })

  it('passes the routine args along', () => {
    make({ target: { kind: 'skill', skillId: 'news-digest', args: '只看中文源' } })
    scheduler.tick(AT('2026-09-04T09:00:01Z'))
    expect(fired[0]?.target).toEqual(
      expect.objectContaining({ kind: 'skill', args: '只看中文源' })
    )
  })

  it('does nothing before the routine is due', () => {
    make()
    expect(scheduler.tick(AT('2026-09-04T08:59:59Z')).fired).toEqual([])
    expect(fired).toHaveLength(0)
  })

  it('skips a routine whose skill is no longer indexed', () => {
    const routine = make({ target: { kind: 'skill', skillId: 'deleted-skill' } })
    const result = scheduler.tick(AT('2026-09-04T09:00:01Z'))

    expect(result.skipped).toEqual([{ routineId: routine.id, reason: 'unknown-skill' }])
    expect(fired).toHaveLength(0)
    expect(store.get(routine.id)?.lastStatus).toBe('skipped')
    // Still advanced, so it does not re-skip on every tick.
    expect(store.get(routine.id)?.nextRunAt).toBe('2026-09-05T09:00:00.000Z')
  })

  it('will not stack a second run on top of one still in flight', () => {
    const routine = make({ cron: '*/5 * * * *' })
    scheduler.tick(AT('2026-09-04T09:00:01Z'))
    expect(fired).toHaveLength(1)

    const result = scheduler.tick(AT('2026-09-04T09:05:01Z'))
    expect(result.skipped).toEqual([
      { routineId: routine.id, reason: 'previous-run-still-active' }
    ])
    expect(fired).toHaveLength(1)
  })

  it('accepts the next firing once the previous run reports back', () => {
    const routine = make({ cron: '*/5 * * * *' })
    scheduler.start(AT('2026-09-04T08:59:00Z'))
    scheduler.tick(AT('2026-09-04T09:00:01Z'))

    bus.emit('skill:run:completed', {
      runId: 'run-1',
      skillId: 'news-digest',
      routineId: routine.id,
      status: 'succeeded',
      exitCode: 0,
      endedAt: '2026-09-04T09:01:00Z'
    })

    scheduler.tick(AT('2026-09-04T09:05:01Z'))
    expect(fired).toHaveLength(2)
    expect(store.get(routine.id)?.lastStatus).toBe('running')
  })

  it('records the completed status and run id on the routine', () => {
    const routine = make()
    scheduler.start(AT('2026-09-04T08:00:00Z'))
    scheduler.tick(AT('2026-09-04T09:00:01Z'))

    bus.emit('skill:run:completed', {
      runId: 'run-7',
      skillId: 'news-digest',
      routineId: routine.id,
      status: 'failed',
      exitCode: 1,
      endedAt: '2026-09-04T09:01:00Z'
    })

    expect(store.get(routine.id)).toMatchObject({ lastStatus: 'failed', lastRunId: 'run-7' })
  })

  it('ignores completions from runs it did not trigger', () => {
    make()
    scheduler.start(AT('2026-09-04T08:00:00Z'))

    bus.emit('skill:run:completed', {
      runId: 'manual',
      skillId: 'news-digest',
      routineId: null,
      status: 'failed',
      exitCode: 1,
      endedAt: '2026-09-04T09:01:00Z'
    })

    expect(scheduler.pendingRetries()).toBe(0)
  })

  it('runNow fires a routine that is not yet due, without touching its schedule', () => {
    const routine = make()
    const nextRunBefore = store.get(routine.id)?.nextRunAt

    scheduler.runNow(routine.id, AT('2026-09-04T08:30:00Z'))

    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ routineId: routine.id, attempt: 1 })
    expect(store.get(routine.id)?.nextRunAt).toBe(nextRunBefore)
  })

  it('runNow still refuses a target the guardrail rejects', () => {
    const routine = make({ target: { kind: 'skill', skillId: 'deleted-skill' } })

    expect(() => scheduler.runNow(routine.id, AT('2026-09-04T08:30:00Z'))).toThrow('unknown-skill')
    expect(fired).toHaveLength(0)
    expect(store.get(routine.id)?.lastStatus).toBe('skipped')
  })

  it('runNow refuses to double-run a routine still in flight', () => {
    const routine = make({ cron: '*/5 * * * *' })
    scheduler.tick(AT('2026-09-04T09:00:01Z'))
    expect(fired).toHaveLength(1)

    expect(() => scheduler.runNow(routine.id, AT('2026-09-04T09:01:00Z'))).toThrow(
      'previous run still active'
    )
    expect(fired).toHaveLength(1)
  })

  it('runNow rejects an unknown routine id', () => {
    expect(() => scheduler.runNow('no-such-routine')).toThrow('unknown routine')
  })
})

describe('RoutineScheduler startup reconciliation', () => {
  let fired: ArmsEvents['routine:fired'][]
  let scheduler: RoutineScheduler

  function build(): RoutineScheduler {
    return new RoutineScheduler({ store, bus, checkTarget: () => null })
  }

  beforeEach(() => {
    fired = []
    bus.on('routine:fired', (e) => fired.push(e))
  })

  afterEach(() => scheduler?.stop())

  it('skips a trigger missed while the app was closed, by default', () => {
    const routine = make()
    scheduler = build()

    // Woke up a day and a half later.
    const report = scheduler.start(AT('2026-09-05T20:00:00Z'))

    expect(report).toMatchObject({ loaded: 1, missed: 1, caughtUp: 0, skipped: 1 })
    expect(fired).toHaveLength(0)
    expect(store.get(routine.id)?.lastStatus).toBe('skipped')
    expect(store.get(routine.id)?.nextRunAt).toBe('2026-09-06T09:00:00.000Z')
  })

  it('catches up exactly once when the routine asks for it', () => {
    const routine = make({ missedRunPolicy: 'catch-up-once' })
    scheduler = build()

    // Three occurrences were missed; only one catch-up must happen.
    const report = scheduler.start(AT('2026-09-07T20:00:00Z'))

    expect(report).toMatchObject({ missed: 1, caughtUp: 1, skipped: 0 })
    expect(fired).toHaveLength(1)
    expect(fired[0]).toMatchObject({ routineId: routine.id, attempt: 1 })
    expect(store.get(routine.id)?.nextRunAt).toBe('2026-09-08T09:00:00.000Z')
  })

  it('leaves a routine that is not yet due alone', () => {
    make()
    scheduler = build()
    const report = scheduler.start(AT('2026-09-04T08:30:00Z'))

    expect(report).toMatchObject({ missed: 0 })
    expect(fired).toHaveLength(0)
  })

  it('gives a routine with no stored due time one', () => {
    const routine = make({ enabled: false })
    store.update(routine.id, { enabled: true }, AT('2026-09-04T08:00:00Z'))
    // Simulate a row written before next_run_at existed.
    h.db.prepare('UPDATE routines SET next_run_at = NULL WHERE id = ?').run(routine.id)

    scheduler = build()
    scheduler.start(AT('2026-09-04T08:00:00Z'))
    expect(store.get(routine.id)?.nextRunAt).toBe('2026-09-04T09:00:00.000Z')
  })
})

describe('RoutineScheduler retries', () => {
  let fired: ArmsEvents['routine:fired'][]
  let scheduler: RoutineScheduler
  /** Fully controlled clock: no part of this timeline comes from the wall clock. */
  let clockNow: Date

  function fail(routineId: string, runId = 'r'): void {
    bus.emit('skill:run:completed', {
      runId,
      skillId: 'news-digest',
      routineId,
      status: 'failed',
      exitCode: 1,
      endedAt: clockNow.toISOString()
    })
  }

  function advanceTo(iso: string): void {
    clockNow = AT(iso)
  }

  beforeEach(() => {
    fired = []
    clockNow = AT('2026-09-04T08:00:00Z')
    bus.on('routine:fired', (e) => fired.push(e))
    scheduler = new RoutineScheduler({
      store,
      bus,
      checkTarget: () => null,
      clock: () => clockNow
    })
  })

  afterEach(() => scheduler.stop())

  it('does not retry when maxRetries is 0', () => {
    const routine = make()
    scheduler.start()
    advanceTo('2026-09-04T09:00:01Z')
    scheduler.tick()
    fail(routine.id)

    expect(scheduler.pendingRetries()).toBe(0)
  })

  it('does not retry a run that succeeded', () => {
    const routine = make({ maxRetries: 2 })
    scheduler.start()
    advanceTo('2026-09-04T09:00:01Z')
    scheduler.tick()

    bus.emit('skill:run:completed', {
      runId: 'ok',
      skillId: 'news-digest',
      routineId: routine.id,
      status: 'succeeded',
      exitCode: 0,
      endedAt: clockNow.toISOString()
    })

    expect(scheduler.pendingRetries()).toBe(0)
  })

  it('queues a retry after a failure and fires it as attempt 2', () => {
    const routine = make({ maxRetries: 1, retryDelayMs: 0 })
    scheduler.start()
    advanceTo('2026-09-04T09:00:01Z')
    scheduler.tick()
    fail(routine.id)

    expect(scheduler.pendingRetries()).toBe(1)

    advanceTo('2026-09-04T09:01:00Z')
    const result = scheduler.tick()
    expect(result.retried).toEqual([routine.id])
    expect(fired).toHaveLength(2)
    expect(fired[1]?.attempt).toBe(2)
  })

  it('holds the retry until its delay has elapsed', () => {
    const routine = make({ maxRetries: 1, retryDelayMs: 10 * 60_000 })
    scheduler.start()
    advanceTo('2026-09-04T09:00:01Z')
    scheduler.tick()
    fail(routine.id)

    advanceTo('2026-09-04T09:01:00Z')
    scheduler.tick()
    expect(fired).toHaveLength(1)
    expect(scheduler.pendingRetries()).toBe(1)

    advanceTo('2026-09-04T09:11:00Z')
    scheduler.tick()
    expect(fired).toHaveLength(2)
  })

  it('stops retrying once maxRetries is exhausted', () => {
    const routine = make({ maxRetries: 1, retryDelayMs: 0 })
    scheduler.start()
    advanceTo('2026-09-04T09:00:01Z')
    scheduler.tick()

    fail(routine.id, 'run-1')
    advanceTo('2026-09-04T09:01:00Z')
    scheduler.tick()
    expect(fired).toHaveLength(2)

    fail(routine.id, 'run-2')
    expect(scheduler.pendingRetries()).toBe(0)
    advanceTo('2026-09-04T09:02:00Z')
    scheduler.tick()
    expect(fired).toHaveLength(2)
  })

  it('does not let a scheduled occurrence sneak into a retry-only tick', () => {
    // Guards the bug this rewrite fixed: when the retry timeline and the cron
    // timeline share a clock, a late tick must not silently fire both.
    const routine = make({ maxRetries: 1, retryDelayMs: 60_000 })
    scheduler.start()
    advanceTo('2026-09-04T09:00:01Z')
    scheduler.tick()
    fail(routine.id)

    advanceTo('2026-09-04T09:02:00Z')
    const result = scheduler.tick()
    expect(result.retried).toEqual([routine.id])
    expect(result.fired).toEqual([])
  })
})
