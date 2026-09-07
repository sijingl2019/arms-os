import type { Db } from './db'

/**
 * Settings the user changes at runtime, as opposed to the defaults and
 * environment variables `config.ts` starts from.
 *
 * Precedence is stored value > environment > default. The environment stays
 * useful for a scripted or CI setup; once someone has chosen something in the
 * UI, that choice has to survive a restart, which an env var cannot express.
 */
export const SETTING_KEYS = {
  memoryRoots: 'memory.roots',
  memoryRouterRoot: 'memory.routerRoot'
} as const

export class SettingsStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @at)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run({ key, value, at: new Date().toISOString() })
  }

  remove(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  /** A stored list, or undefined when the user has never set one. */
  getList(key: string): string[] | undefined {
    const raw = this.get(key)
    if (raw === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return undefined
    }
  }

  setList(key: string, value: string[]): void {
    this.set(key, JSON.stringify(value))
  }
}
