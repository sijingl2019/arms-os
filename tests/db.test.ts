import { describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION, migrate, openDb } from '@main/db'

describe('schema migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const db = openDb(':memory:')
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)
    db.close()
  })

  it('creates the skills and runs tables', () => {
    const db = openDb(':memory:')
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((r) => r.name)

    expect(names).toContain('skills')
    expect(names).toContain('runs')
    db.close()
  })

  it('is a no-op when run again', () => {
    const db = openDb(':memory:')
    expect(() => migrate(db)).not.toThrow()
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION)
    db.close()
  })
})
