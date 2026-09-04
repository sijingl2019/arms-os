import type {
  MemoryAreaSummary,
  MemoryEntry,
  MemorySearchHit,
  MemorySearchQuery
} from '@shared/types'
import type { Db } from '../db'

interface MemoryRow {
  path: string
  root: string
  rel_path: string
  name: string
  ext: string
  area: string
  size: number
  mtime_ms: number
  title: string
  excerpt: string
  indexed_at: string
}

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    path: row.path,
    root: row.root,
    relPath: row.rel_path,
    name: row.name,
    ext: row.ext,
    area: row.area,
    size: row.size,
    mtimeMs: row.mtime_ms,
    title: row.title,
    excerpt: row.excerpt,
    indexedAt: row.indexed_at
  }
}

/** trigram's floor: shorter queries cannot be served by the FTS index at all. */
const TRIGRAM_MIN_CHARS = 3

/**
 * Escape a user query into a single FTS5 phrase.
 *
 * The query box takes prose, not FTS syntax. Quoting the whole thing means a
 * stray `"` or `*` is searched for rather than changing the query's meaning.
 */
function asPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`
}

export interface UpsertResult {
  added: number
  updated: number
}

/**
 * Owns `memory_index` and its FTS5 shadow (系统设计文档 §6.3).
 *
 * Writes go through prepared statements inside one transaction per batch: at
 * 50k files, a transaction per file is what makes an index rebuild take
 * minutes instead of seconds.
 */
export class MemoryStore {
  private readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  /**
   * Everything the incremental sweep needs to decide "has this changed?",
   * loaded once. mtime+size rather than a content hash: hashing 50k files on
   * every sweep costs far more than it saves, and a same-mtime-same-size edit
   * is rare enough to be worth a `--rehash` escape hatch instead.
   */
  stamps(): Map<string, { mtimeMs: number; size: number }> {
    const rows = this.db
      .prepare('SELECT path, mtime_ms, size FROM memory_index')
      .all() as Array<{ path: string; mtime_ms: number; size: number }>

    const out = new Map<string, { mtimeMs: number; size: number }>()
    for (const row of rows) out.set(row.path, { mtimeMs: row.mtime_ms, size: row.size })
    return out
  }

  /** Insert or update a batch in one transaction. */
  upsertBatch(entries: MemoryEntry[], known: Set<string>): UpsertResult {
    const statement = this.db.prepare(`
      INSERT INTO memory_index (path, root, rel_path, name, ext, area, size, mtime_ms,
                                title, excerpt, indexed_at)
      VALUES (@path, @root, @rel_path, @name, @ext, @area, @size, @mtime_ms,
              @title, @excerpt, @indexed_at)
      ON CONFLICT(path) DO UPDATE SET
        root = excluded.root, rel_path = excluded.rel_path, name = excluded.name,
        ext = excluded.ext, area = excluded.area, size = excluded.size,
        mtime_ms = excluded.mtime_ms, title = excluded.title,
        excerpt = excluded.excerpt, indexed_at = excluded.indexed_at
    `)

    const result: UpsertResult = { added: 0, updated: 0 }

    this.db.transaction(() => {
      for (const entry of entries) {
        statement.run({
          path: entry.path,
          root: entry.root,
          rel_path: entry.relPath,
          name: entry.name,
          ext: entry.ext,
          area: entry.area,
          size: entry.size,
          mtime_ms: entry.mtimeMs,
          title: entry.title,
          excerpt: entry.excerpt,
          indexed_at: entry.indexedAt
        })
        if (known.has(entry.path)) result.updated += 1
        else result.added += 1
      }
    })()

    return result
  }

  /** Drop rows whose files are gone. Batched for the same reason as upserts. */
  removeMissing(paths: Iterable<string>): number {
    const statement = this.db.prepare('DELETE FROM memory_index WHERE path = ?')
    let removed = 0
    this.db.transaction(() => {
      for (const path of paths) removed += statement.run(path).changes
    })()
    return removed
  }

  /** Forget a whole root, e.g. when it is removed from the configuration. */
  removeRoot(root: string): number {
    return this.db.prepare('DELETE FROM memory_index WHERE root = ?').run(root).changes
  }

  /** Paths currently indexed under a root, for reconciling deletions. */
  pathsUnder(root: string): Set<string> {
    const rows = this.db
      .prepare('SELECT path FROM memory_index WHERE root = ?')
      .all(root) as Array<{ path: string }>
    return new Set(rows.map((r) => r.path))
  }

  get(path: string): MemoryEntry | undefined {
    const row = this.db.prepare('SELECT * FROM memory_index WHERE path = ?').get(path) as
      | MemoryRow
      | undefined
    return row ? toEntry(row) : undefined
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM memory_index').get() as { n: number }
    return row.n
  }

  areas(): MemoryAreaSummary[] {
    const rows = this.db
      .prepare(
        `SELECT area, count(*) AS files, max(mtime_ms) AS newest
           FROM memory_index GROUP BY area ORDER BY files DESC, area`
      )
      .all() as Array<{ area: string; files: number; newest: number | null }>

    return rows.map((row) => ({
      area: row.area,
      files: row.files,
      lastModified: row.newest ? new Date(row.newest).toISOString() : null
    }))
  }

  /** Files in one area, newest first - what a domain index file is built from. */
  listArea(area: string, limit = 500): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_index WHERE area = ? ORDER BY mtime_ms DESC, rel_path LIMIT ?`
      )
      .all(area, limit) as MemoryRow[]
    return rows.map(toEntry)
  }

  lastIndexedAt(): string | null {
    const row = this.db.prepare('SELECT max(indexed_at) AS at FROM memory_index').get() as {
      at: string | null
    }
    return row.at
  }

  /**
   * Full-text search, ranked by bm25.
   *
   * A query shorter than a trigram cannot use the index, so those fall back to
   * a bounded `LIKE` over name and title. That keeps a two-character Chinese
   * query working instead of silently returning nothing, without ever letting
   * a one-character query drag the whole table back.
   */
  search({ query, area, limit = 40 }: MemorySearchQuery): MemorySearchHit[] {
    const needle = query.trim()
    if (!needle) return []

    return [...needle].length < TRIGRAM_MIN_CHARS
      ? this.searchFallback(needle, area, limit)
      : this.searchFts(needle, area, limit)
  }

  private searchFts(needle: string, area: string | undefined, limit: number): MemorySearchHit[] {
    const where = area ? 'AND m.area = ?' : ''
    const params: unknown[] = [asPhrase(needle)]
    if (area) params.push(area)
    params.push(limit)

    try {
      const rows = this.db
        .prepare(
          `SELECT m.path, m.rel_path, m.name, m.area, m.title,
                  snippet(memory_fts, 3, '<<', '>>', '…', 16) AS snippet,
                  bm25(memory_fts) AS score
             FROM memory_fts
             JOIN memory_index m ON m.id = memory_fts.rowid
            WHERE memory_fts MATCH ? ${where}
            ORDER BY score
            LIMIT ?`
        )
        .all(...params) as Array<{
        path: string
        rel_path: string
        name: string
        area: string
        title: string
        snippet: string
        score: number
      }>

      return rows.map((row) => ({
        path: row.path,
        relPath: row.rel_path,
        name: row.name,
        area: row.area,
        title: row.title,
        snippet: row.snippet,
        score: row.score
      }))
    } catch {
      // A query FTS5 cannot parse should degrade to something, not explode.
      return this.searchFallback(needle, area, limit)
    }
  }

  private searchFallback(
    needle: string,
    area: string | undefined,
    limit: number
  ): MemorySearchHit[] {
    const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const where = area ? 'AND area = ?' : ''
    const params: unknown[] = [like, like]
    if (area) params.push(area)
    params.push(limit)

    const rows = this.db
      .prepare(
        `SELECT path, rel_path, name, area, title
           FROM memory_index
          WHERE (name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') ${where}
          ORDER BY mtime_ms DESC
          LIMIT ?`
      )
      .all(...params) as Array<{
      path: string
      rel_path: string
      name: string
      area: string
      title: string
    }>

    return rows.map((row) => ({
      path: row.path,
      relPath: row.rel_path,
      name: row.name,
      area: row.area,
      title: row.title,
      snippet: '',
      score: 0
    }))
  }
}
