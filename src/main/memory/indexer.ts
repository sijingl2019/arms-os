import type {
  MemoryEntry,
  MemoryIndexResult,
  MemoryIndexStatus,
  MemorySearchHit,
  MemorySearchQuery
} from '@shared/types'
import type { ArmsBus } from '../bus'
import type { ArmsConfig } from '../config'
import { extract } from './extract'
import { writeRouterFiles } from './router'
import type { MemoryStore } from './store'
import { walkRoots } from './walk'

/**
 * Rows per transaction.
 *
 * better-sqlite3 is synchronous and the FTS5 trigram index is CPU-heavy, so a
 * batch is the longest single block the event loop can suffer. 500 measured at
 * ~325ms of peak lag on a 50k-file sweep; 100 keeps it well under a frame while
 * still amortising the transaction overhead.
 */
const BATCH_SIZE = 100
/** How often to publish progress, in files seen. */
const PROGRESS_EVERY = 250

export interface MemoryIndexerDeps {
  store: MemoryStore
  config: ArmsConfig
  bus: ArmsBus
}

export interface RefreshOptions {
  /**
   * Re-read and re-index every file even when its stamp is unchanged. The
   * escape hatch for the one case mtime+size misses: an edit that preserved
   * both, or a change to how excerpts are extracted.
   */
  force?: boolean
  /** Limit the sweep to one root. */
  root?: string
  /** Regenerate CLAUDE.md and areas/*.md afterwards (架构规范 §5.1). */
  writeRouter?: boolean
  /** Plan the router files without writing them. */
  dryRunRouter?: boolean
}

/**
 * Incremental indexer for the knowledge base (系统设计文档 §6.3).
 *
 * Two properties matter more than anything else here, because the previous
 * implementation lacked both and hit a wall at ~50k files:
 *
 *  - **No file cap.** The walk streams, and rows are written in batches, so
 *    peak memory does not grow with the vault. Indexing part of a vault and
 *    saying nothing is worse than taking longer.
 *  - **Only changed files are read.** A sweep stats everything but opens only
 *    what moved, so a re-index of an unchanged vault is bounded by `stat`.
 */
export class MemoryIndexer {
  private readonly store: MemoryStore
  private readonly config: ArmsConfig
  private readonly bus: ArmsBus

  private running = false
  private lastResult: MemoryIndexResult | null = null

  constructor({ store, config, bus }: MemoryIndexerDeps) {
    this.store = store
    this.config = config
    this.bus = bus
  }

  get isIndexing(): boolean {
    return this.running
  }

  status(): MemoryIndexStatus {
    return {
      roots: this.config.memoryRoots,
      routerRoot: this.config.memoryRouterRoot,
      indexing: this.running,
      totalFiles: this.store.count(),
      areas: this.store.areas(),
      lastResult: this.lastResult,
      lastIndexedAt: this.store.lastIndexedAt()
    }
  }

  search(query: MemorySearchQuery): MemorySearchHit[] {
    return this.store.search(query)
  }

  /**
   * Sweep the configured roots and reconcile the index.
   *
   * @throws if a sweep is already running - two concurrent sweeps would fight
   *   over the same rows and produce nonsense deletion sets.
   */
  async refresh(opts: RefreshOptions = {}): Promise<MemoryIndexResult> {
    if (this.running) throw new Error('an index sweep is already running')

    const roots = opts.root ? [opts.root] : this.config.memoryRoots
    const started = Date.now()
    const result: MemoryIndexResult = {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      skipped: 0,
      durationMs: 0,
      warnings: [],
      routerFiles: []
    }

    if (roots.length === 0) {
      result.durationMs = Date.now() - started
      this.lastResult = result
      return result
    }

    this.running = true
    try {
      const stamps = this.store.stamps()
      const known = new Set(stamps.keys())
      // Everything currently indexed under these roots; whatever is still here
      // when the walk ends no longer exists on disk.
      const missing = new Set<string>()
      for (const root of roots) for (const p of this.store.pathsUnder(root)) missing.add(p)

      let batch: MemoryEntry[] = []
      let seen = 0
      let currentRoot: string | null = null

      const flush = (): void => {
        if (batch.length === 0) return
        const written = this.store.upsertBatch(batch, known)
        result.added += written.added
        result.updated += written.updated
        for (const entry of batch) known.add(entry.path)
        batch = []
      }

      /** Flush, then hand the event loop back before filling the next batch. */
      const flushAndYield = async (): Promise<void> => {
        flush()
        await new Promise((resolve) => setImmediate(resolve))
      }

      for await (const file of walkRoots({
        roots,
        onWarning: (message) => {
          result.warnings.push(message)
          result.skipped += 1
        }
      })) {
        seen += 1
        currentRoot = file.root
        missing.delete(file.path)

        const stamp = stamps.get(file.path)
        const unchanged =
          !opts.force && stamp?.mtimeMs === file.mtimeMs && stamp.size === file.size

        if (unchanged) {
          result.unchanged += 1
        } else {
          const { title, excerpt } = await extract(file, {
            excerptBytes: this.config.memoryExcerptBytes,
            maxFileBytes: this.config.memoryMaxFileBytes
          })
          batch.push({
            path: file.path,
            root: file.root,
            relPath: file.relPath,
            name: file.name,
            ext: file.ext,
            area: file.area,
            size: file.size,
            mtimeMs: file.mtimeMs,
            title,
            excerpt,
            indexedAt: new Date().toISOString()
          })
          if (batch.length >= BATCH_SIZE) await flushAndYield()
        }

        if (seen % PROGRESS_EVERY === 0) {
          this.bus.emit('memory:index:progress', {
            phase: 'scanning',
            seen,
            changed: result.added + result.updated,
            currentRoot
          })
          // Hand the event loop back between batches so IPC, the Gateway and
          // the scheduler stay responsive during a long sweep.
          await new Promise((resolve) => setImmediate(resolve))
        }
      }

      this.bus.emit('memory:index:progress', {
        phase: 'writing',
        seen,
        changed: result.added + result.updated,
        currentRoot
      })
      flush()
      result.removed = this.store.removeMissing(missing)

      // Router files are generated from the index, so they are only correct
      // once the sweep has reconciled deletions.
      if (opts.writeRouter && this.config.memoryRouterRoot) {
        this.bus.emit('memory:index:progress', {
          phase: 'routing',
          seen,
          changed: result.added + result.updated,
          currentRoot
        })
        try {
          result.routerFiles = await writeRouterFiles({
            store: this.store,
            routerRoot: this.config.memoryRouterRoot,
            ...(opts.dryRunRouter ? { dryRun: true } : {})
          })
        } catch (err) {
          // A failed router write must not invalidate a good index.
          result.warnings.push(`router: ${(err as Error).message}`)
        }
      }

      result.durationMs = Date.now() - started
      this.lastResult = result
      this.bus.emit('memory:index:completed', result)
      return result
    } finally {
      this.running = false
    }
  }
}
