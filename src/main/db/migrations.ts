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
  },

  function v2(db) {
    db.exec(`
      CREATE TABLE routines (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        skill_id           TEXT NOT NULL,
        cron               TEXT NOT NULL,
        timezone           TEXT,
        args               TEXT,
        agent              TEXT,
        model              TEXT,
        effort             TEXT,
        enabled            INTEGER NOT NULL DEFAULT 1,
        missed_run_policy  TEXT NOT NULL DEFAULT 'skip',
        max_retries        INTEGER NOT NULL DEFAULT 0,
        retry_delay_ms     INTEGER NOT NULL DEFAULT 60000,
        next_run_at        TEXT,
        last_run_at        TEXT,
        last_status        TEXT,
        last_run_id        TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      -- The scheduler's hot query is "what is due now", so index the due column.
      CREATE INDEX idx_routines_due ON routines (enabled, next_run_at);

      -- Attribute a run back to the routine that triggered it.
      ALTER TABLE runs ADD COLUMN routine_id TEXT;
      CREATE INDEX idx_runs_routine ON runs (routine_id, started_at DESC);
    `)
  },

  function v3(db) {
    db.exec(`
      -- Every tool call through the Gateway, decided or not.
      --
      -- 设计文档 §7 folds Gateway calls into the runs table. They are kept
      -- apart here because the two have almost no columns in common: a run has
      -- a command line, an exit code and streamed output; a tool call has a
      -- connector, a JSON argument object and a risk decision. Merging them
      -- would mean a table that is half NULL whichever kind of row you look at.
      CREATE TABLE tool_calls (
        call_id         TEXT PRIMARY KEY,
        connector_id    TEXT NOT NULL,
        tool_name       TEXT NOT NULL,
        qualified_name  TEXT NOT NULL,
        args            TEXT NOT NULL DEFAULT '{}',
        risk            TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        confirmation_id TEXT,
        run_id          TEXT,
        session_id      TEXT,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        duration_ms     INTEGER,
        result          TEXT,
        error           TEXT
      );

      CREATE INDEX idx_tool_calls_started ON tool_calls (started_at DESC);
      CREATE INDEX idx_tool_calls_connector ON tool_calls (connector_id, started_at DESC);

      -- The approval queue behind a write-irreversible action (§2.3).
      CREATE TABLE confirmations (
        confirmation_id TEXT PRIMARY KEY,
        connector_id    TEXT NOT NULL,
        tool_name       TEXT NOT NULL,
        qualified_name  TEXT NOT NULL,
        args            TEXT NOT NULL DEFAULT '{}',
        risk            TEXT NOT NULL,
        run_id          TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        reason          TEXT,
        requested_at    TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        decided_at      TEXT
      );

      CREATE INDEX idx_confirmations_status ON confirmations (status, requested_at DESC);
    `)
  },

  function v4(db) {
    db.exec(`
      CREATE TABLE memory_index (
        id          INTEGER PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,
        root        TEXT NOT NULL,
        rel_path    TEXT NOT NULL,
        name        TEXT NOT NULL,
        ext         TEXT NOT NULL DEFAULT '',
        area        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        mtime_ms    INTEGER NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        excerpt     TEXT NOT NULL DEFAULT '',
        indexed_at  TEXT NOT NULL
      );

      CREATE INDEX idx_memory_root ON memory_index (root);
      CREATE INDEX idx_memory_area ON memory_index (area, name);
      -- The incremental sweep's hot comparison is (mtime, size) per path.
      CREATE INDEX idx_memory_stamp ON memory_index (path, mtime_ms, size);

      -- trigram, not unicode61: unicode61 treats a run of CJK as a single
      -- token, so a Chinese substring query matches nothing at all. trigram
      -- handles CJK substrings and English alike. Its floor is three
      -- characters, which the store falls back to a bounded LIKE scan for.
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        name, title, area, excerpt,
        content = 'memory_index',
        content_rowid = 'id',
        tokenize = 'trigram'
      );

      -- External-content FTS has to be told about every change; triggers keep
      -- the two in step so no write path can forget.
      CREATE TRIGGER memory_ai AFTER INSERT ON memory_index BEGIN
        INSERT INTO memory_fts (rowid, name, title, area, excerpt)
        VALUES (new.id, new.name, new.title, new.area, new.excerpt);
      END;

      CREATE TRIGGER memory_ad AFTER DELETE ON memory_index BEGIN
        INSERT INTO memory_fts (memory_fts, rowid, name, title, area, excerpt)
        VALUES ('delete', old.id, old.name, old.title, old.area, old.excerpt);
      END;

      CREATE TRIGGER memory_au AFTER UPDATE ON memory_index BEGIN
        INSERT INTO memory_fts (memory_fts, rowid, name, title, area, excerpt)
        VALUES ('delete', old.id, old.name, old.title, old.area, old.excerpt);
        INSERT INTO memory_fts (rowid, name, title, area, excerpt)
        VALUES (new.id, new.name, new.title, new.area, new.excerpt);
      END;
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
