import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrations'

export type Db = Database.Database

const IN_MEMORY = ':memory:'

/**
 * Open (creating if needed) the ARMS state database and migrate it to the
 * latest schema. WAL is skipped for in-memory databases, which tests use.
 */
export function openDb(file: string): Db {
  if (file !== IN_MEMORY) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }

  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  if (file !== IN_MEMORY) {
    db.pragma('journal_mode = WAL')
    // Durable enough for a local single-user app, and far cheaper than FULL.
    db.pragma('synchronous = NORMAL')
  }

  migrate(db)
  return db
}

export { migrate, LATEST_SCHEMA_VERSION } from './migrations'
