import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type ArmsCore } from '@main/core'
import type { SpawnRequest, Spawner, SpawnCallbacks } from '@main/agents/types'
import { skillDoc } from './helpers'

/**
 * Exercises the wiring in core.ts: a routine coming due must travel
 * scheduler -> bus -> executor -> runs table, with nobody calling anyone
 * directly. The units are covered elsewhere; this is about the seams.
 */

let dir: string
let core: ArmsCore
let calls: SpawnRequest[]
let callbacks: SpawnCallbacks | undefined

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arms-core-'))
  const skillDir = path.join(dir, '.claude', 'skills', 'news-digest')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, 'SKILL.md'), skillDoc({ name: 'news-digest' }), 'utf8')

  calls = []
  const spawner: Spawner = (req, cb) => {
    calls.push(req)
    callbacks = cb
    return { cancel: () => cb.onExit({ code: null, signal: null, reason: 'cancelled' }) }
  }

  core = createCore({
    workspaceRoot: dir,
    stateDir: path.join(dir, 'state'),
    dbPath: ':memory:',
    scanRoots: [{ dir: path.join(dir, '.claude', 'skills'), source: 'workspace' }],
    spawner
  })
})

afterEach(() => {
  core.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('core wiring', () => {
  it('carries a due routine all the way to a run record', async () => {
    await core.registry.refresh()
    const routine = core.routines.create(
      { name: 'digest', skillId: 'news-digest', cron: '0 9 * * *', timezone: 'UTC' },
      new Date('2026-09-04T08:00:00Z')
    )

    core.scheduler.tick(new Date('2026-09-04T09:00:01Z'))
    // routine:fired -> executor.run is async, so let the microtask queue drain.
    await new Promise((resolve) => setImmediate(resolve))

    expect(calls).toHaveLength(1)
    const [run] = core.executor.history({ routineId: routine.id })
    expect(run).toMatchObject({
      skillId: 'news-digest',
      routineId: routine.id,
      trigger: 'routine',
      status: 'running'
    })
  })

  it('reports the run outcome back onto the routine', async () => {
    await core.registry.refresh()
    const routine = core.routines.create(
      { name: 'digest', skillId: 'news-digest', cron: '0 9 * * *', timezone: 'UTC' },
      new Date('2026-09-04T08:00:00Z')
    )
    core.startScheduler(new Date('2026-09-04T08:00:00Z'))

    core.scheduler.tick(new Date('2026-09-04T09:00:01Z'))
    await new Promise((resolve) => setImmediate(resolve))
    callbacks?.onExit({ code: 0, signal: null, reason: 'exit' })

    expect(core.routines.get(routine.id)?.lastStatus).toBe('succeeded')
    expect(core.routines.get(routine.id)?.lastRunId).toBe(
      core.executor.history({ routineId: routine.id })[0]?.runId
    )
  })

  it('refuses to fire a routine whose skill is not indexed', async () => {
    // Registry deliberately not refreshed, so the skill is unknown.
    core.routines.create(
      { name: 'digest', skillId: 'news-digest', cron: '0 9 * * *', timezone: 'UTC' },
      new Date('2026-09-04T08:00:00Z')
    )

    const result = core.scheduler.tick(new Date('2026-09-04T09:00:01Z'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(result.skipped[0]?.reason).toBe('unknown-skill')
    expect(calls).toHaveLength(0)
  })

  it('does not tick until the scheduler is explicitly started', async () => {
    await core.registry.refresh()
    core.routines.create(
      { name: 'digest', skillId: 'news-digest', cron: '* * * * *', timezone: 'UTC' },
      new Date('2026-09-04T08:00:00Z')
    )

    // createCore must not have armed a timer; only startScheduler does.
    expect(core.schedulerReport).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toHaveLength(0)
  })

  it('reconciles missed triggers when the scheduler finally starts', async () => {
    await core.registry.refresh()
    core.routines.create(
      { name: 'digest', skillId: 'news-digest', cron: '0 9 * * *', timezone: 'UTC' },
      new Date('2026-09-04T08:00:00Z')
    )

    const report = core.startScheduler(new Date('2026-09-06T12:00:00Z'))
    expect(report).toMatchObject({ loaded: 1, missed: 1, skipped: 1 })
    expect(core.schedulerReport).toEqual(report)
    expect(calls).toHaveLength(0)
  })
})
