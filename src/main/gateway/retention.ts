import type { Db } from '../db'

/**
 * Retention for the Gateway audit trail.
 *
 * The table has two very different populations in it. A widget refreshing every
 * two minutes contributes ~720 successful read-only rows a day and is worthless
 * a week later. A call that was denied, expired, blocked or failed - or any
 * write at all - is exactly what you go looking for months afterwards when
 * something went wrong.
 *
 * So retention tracks forensic value rather than age alone: keep the rows you
 * would want during an incident for a long time, and let the refresh noise go.
 */

export interface RetentionPolicy {
  /**
   * Days to keep anything worth investigating: every non-`read-only` call, and
   * every call that did not simply succeed.
   */
  keepDays: number
  /** Days to keep successful read-only calls - the widget-refresh noise. */
  keepReadOnlyDays: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepDays: 90,
  keepReadOnlyDays: 7
}

export interface PruneResult {
  /** Rows removed because they aged past `keepDays`. */
  aged: number
  /** Successful read-only rows removed past `keepReadOnlyDays`. */
  noise: number
  total: number
  /** The cutoffs actually applied, after clamping. */
  cutoffs: { keep: string; readOnly: string }
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - Math.max(0, days) * 86_400_000).toISOString()
}

/**
 * Apply the policy.
 *
 * The two rules are run as separate statements so the result can say which one
 * removed what: "we dropped 5000 rows" is much less useful than knowing whether
 * that was a week of widget refreshes or three months of real history.
 */
export function pruneToolCalls(
  db: Db,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now = new Date()
): PruneResult {
  // A read-only window longer than the overall window would never fire, and
  // almost certainly means the two were set the wrong way round.
  const readOnlyDays = Math.min(policy.keepReadOnlyDays, policy.keepDays)

  const keepCutoff = daysAgo(now, policy.keepDays)
  const readOnlyCutoff = daysAgo(now, readOnlyDays)

  const prune = db.transaction(() => {
    const aged = db.prepare('DELETE FROM tool_calls WHERE started_at < ?').run(keepCutoff).changes
    const noise = db
      .prepare(
        `DELETE FROM tool_calls
          WHERE started_at < ? AND outcome = 'succeeded' AND risk = 'read-only'`
      )
      .run(readOnlyCutoff).changes
    return { aged, noise }
  })

  const { aged, noise } = prune()
  return {
    aged,
    noise,
    total: aged + noise,
    cutoffs: { keep: keepCutoff, readOnly: readOnlyCutoff }
  }
}

/**
 * Reclaim the space those deletes freed.
 *
 * Deleting rows does not shrink the file: SQLite keeps the pages and reuses
 * them. `auto_vacuum` would return them automatically but can only be set
 * before any table exists, so an existing database needs a full `VACUUM` -
 * which rewrites the file and is far too expensive to run on a timer. It is
 * therefore a command the user invokes, not part of the pruning sweep.
 */
export function compact(db: Db): { before: number; after: number } {
  const size = (): number => {
    const row = db
      .prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()')
      .get() as { bytes: number }
    return row.bytes
  }

  const before = size()
  db.exec('VACUUM')
  return { before, after: size() }
}
