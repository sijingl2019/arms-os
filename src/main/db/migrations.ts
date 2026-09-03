import type { Database } from 'better-sqlite3'

/**
 * Schema versions, applied in order. Append only - never edit a shipped entry,
 * add the next one. The index is the version: MIGRATIONS[0] takes user_version
 * 0 -> 1.
 */
const MIGRATIONS: Array<(db: Database) => void> = [
  function v1(db) {
    db.exec(`
      CREATE TABLE skills (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        source           TEXT NOT NULL,
        path             TEXT NOT NULL,
        triggers         TEXT NOT NULL DEFAULT '[]',
        model_hint       TEXT,
        effort_hint      TEXT,
        forbidden        TEXT NOT NULL DEFAULT '[]',
        confirm_required TEXT NOT NULL DEFAULT '[]',
        connectors       TEXT NOT NULL DEFAULT '[]',
        lines            INTEGER NOT NULL DEFAULT 0,
        content_hash     TEXT NOT NULL,
        indexed_at       TEXT NOT NULL
      );

      CREATE TABLE runs (
        run_id      TEXT PRIMARY KEY,
        skill_id    TEXT,
        label       TEXT NOT NULL,
        trigger     TEXT NOT NULL,
        agent       TEXT NOT NULL,
        model       TEXT,
        effort      TEXT,
        cwd         TEXT NOT NULL,
        command     TEXT NOT NULL,
        status      TEXT NOT NULL,
        exit_code   INTEGER,
        started_at  TEXT NOT NULL,
        ended_at    TEXT,
        duration_ms INTEGER,
        output      TEXT NOT NULL DEFAULT '',
        error       TEXT
      );

      CREATE INDEX idx_runs_skill ON runs (skill_id, started_at DESC);
      CREATE INDEX idx_runs_started ON runs (started_at DESC);
    `)
  }
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length

/**
 * Bring the database up to LATEST_SCHEMA_VERSION. Each step runs inside its own
 * transaction, so a failure leaves the db at the last good version rather than
 * half-migrated.
 */
export function migrate(db: Database): number {
  let version = db.pragma('user_version', { simple: true }) as number

  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version]
    if (!step) break
    const next = version + 1
    db.transaction(() => {
      step(db)
      // user_version does not accept a bound parameter.
      db.pragma(`user_version = ${next}`)
    })()
    version = next
  }

  return version
}
