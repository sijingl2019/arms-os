import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore } from '@main/core'
import { openDb, type Db } from '@main/db'
import { compact, pruneToolCalls, DEFAULT_RETENTION } from '@main/gateway/retention'
import type { RiskLevel } from '@main/gateway/types'
import type { ToolCallOutcome } from '@shared/types'

/**
 * Retention for the audit trail.
 *
 * The rule being tested is not "old rows go" but "the rows you would want
 * during an incident stay". A widget refreshing every two minutes buries the
 * table in successful read-only calls; a refusal from six weeks ago is the one
 * row that matters.
 */

const NOW = new Date('2026-09-04T12:00:00Z')
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString()

let db: Db

function record(opts: {
  days: number
  outcome?: ToolCallOutcome
  risk?: RiskLevel
  tool?: string
}): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO tool_calls (call_id, connector_id, tool_name, qualified_name, args, risk,
                             outcome, started_at)
     VALUES (@id, 'email', @tool, @qualified, '{}', @risk, @outcome, @at)`
  ).run({
    id,
    tool: opts.tool ?? 'list_unread',
    qualified: `email.${opts.tool ?? 'list_unread'}`,
    risk: opts.risk ?? 'read-only',
    outcome: opts.outcome ?? 'succeeded',
    at: daysAgo(opts.days)
  })
  return id
}

const remaining = (): number =>
  (db.prepare('SELECT count(*) AS n FROM tool_calls').get() as { n: number }).n

const survives = (id: string): boolean =>
  db.prepare('SELECT 1 FROM tool_calls WHERE call_id = ?').get(id) !== undefined

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  db.close()
})

describe('what the policy keeps', () => {
  it('drops successful read-only calls once they are stale', () => {
    // The widget-refresh population: high volume, no forensic value.
    const noise = record({ days: 30 })
    const result = pruneToolCalls(db, DEFAULT_RETENTION, NOW)

    expect(result.noise).toBe(1)
    expect(survives(noise)).toBe(false)
  })

  it('keeps a recent read-only call', () => {
    const fresh = record({ days: 2 })
    pruneToolCalls(db, DEFAULT_RETENTION, NOW)
    expect(survives(fresh)).toBe(true)
  })

  it.each<[string, ToolCallOutcome]>([
    ['denied', 'denied'],
    ['expired', 'expired'],
    ['blocked', 'blocked'],
    ['failed', 'failed'],
    ['timed out', 'timeout']
  ])('keeps a read-only call that was %s, long past the noise window', (_label, outcome) => {
    // A call that did not simply succeed is exactly what an incident review
    // goes looking for, whatever its risk tier.
    const id = record({ days: 60, outcome })
    pruneToolCalls(db, DEFAULT_RETENTION, NOW)
    expect(survives(id)).toBe(true)
  })

  it.each<[RiskLevel]>([['write-reversible'], ['write-irreversible']])(
    'keeps a successful %s call, because every write is worth reviewing',
    (risk) => {
      const id = record({ days: 60, risk })
      pruneToolCalls(db, DEFAULT_RETENTION, NOW)
      expect(survives(id)).toBe(true)
    }
  )

  it('eventually drops even a refusal, once it ages past the long window', () => {
    const ancient = record({ days: 200, outcome: 'denied', risk: 'write-irreversible' })
    const result = pruneToolCalls(db, DEFAULT_RETENTION, NOW)

    expect(result.aged).toBe(1)
    expect(survives(ancient)).toBe(false)
  })
})

describe('pruneToolCalls', () => {
  it('reports the two populations separately', () => {
    record({ days: 200 })
    record({ days: 200, risk: 'write-reversible' })
    record({ days: 30 })
    record({ days: 30 })

    const result = pruneToolCalls(db, DEFAULT_RETENTION, NOW)

    // "5000 rows went" is far less useful than knowing which rule took them.
    expect(result).toMatchObject({ aged: 2, noise: 2, total: 4 })
    expect(remaining()).toBe(0)
  })

  it('does nothing to a fresh table', () => {
    record({ days: 1 })
    record({ days: 1, risk: 'write-irreversible' })
    expect(pruneToolCalls(db, DEFAULT_RETENTION, NOW).total).toBe(0)
    expect(remaining()).toBe(2)
  })

  it('is safe to run twice', () => {
    record({ days: 30 })
    expect(pruneToolCalls(db, DEFAULT_RETENTION, NOW).total).toBe(1)
    expect(pruneToolCalls(db, DEFAULT_RETENTION, NOW).total).toBe(0)
  })

  it('honours a custom policy', () => {
    const id = record({ days: 3 })
    pruneToolCalls(db, { keepDays: 90, keepReadOnlyDays: 1 }, NOW)
    expect(survives(id)).toBe(false)
  })

  it('clamps a read-only window set longer than the overall one', () => {
    // Reversed by mistake: the read-only rule can never outlive the hard cutoff,
    // so it is clamped rather than silently never firing.
    const id = record({ days: 20 })
    const result = pruneToolCalls(db, { keepDays: 10, keepReadOnlyDays: 60 }, NOW)

    expect(result.cutoffs.readOnly).toBe(result.cutoffs.keep)
    expect(survives(id)).toBe(false)
  })

  it('copes with an empty table', () => {
    expect(pruneToolCalls(db, DEFAULT_RETENTION, NOW)).toMatchObject({ total: 0 })
  })
})

describe('compact', () => {
  it('reports the file size on both sides of a VACUUM', () => {
    for (let i = 0; i < 200; i += 1) record({ days: 200 })
    pruneToolCalls(db, DEFAULT_RETENTION, NOW)

    const { before, after } = compact(db)
    // An in-memory database has little to reclaim; what matters is that VACUUM
    // runs without throwing and reports both sides.
    expect(before).toBeGreaterThan(0)
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThanOrEqual(before)
  })

  it('leaves the surviving rows intact', () => {
    const keep = record({ days: 1, risk: 'write-irreversible' })
    record({ days: 200 })
    pruneToolCalls(db, DEFAULT_RETENTION, NOW)
    compact(db)

    expect(survives(keep)).toBe(true)
    expect(remaining()).toBe(1)
  })
})

describe('the Gateway applies it on startup', () => {
  it('prunes when it starts and reports what it took', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'arms-retention-'))
    const dbPath = path.join(dir, 'arms.db')

    // Seed a stale row through a first core, then reopen and start the Gateway.
    const seeder = createCore({ workspaceRoot: dir, stateDir: dir, dbPath, scanRoots: [] })
    seeder.db
      .prepare(
        `INSERT INTO tool_calls (call_id, connector_id, tool_name, qualified_name, args, risk,
                                 outcome, started_at)
         VALUES ('old', 'email', 'list_unread', 'email.list_unread', '{}', 'read-only',
                 'succeeded', ?)`
      )
      .run(new Date(Date.now() - 40 * 86_400_000).toISOString())
    await seeder.close()

    const core = createCore({
      workspaceRoot: dir,
      stateDir: dir,
      dbPath,
      scanRoots: [],
      gatewayPort: 39480
    })
    try {
      const started = await core.startGateway()
      expect(started.pruned.noise).toBe(1)
      expect(
        (core.db.prepare('SELECT count(*) AS n FROM tool_calls').get() as { n: number }).n
      ).toBe(0)
    } finally {
      await core.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    }
  })
})
