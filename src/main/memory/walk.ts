import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'

/**
 * Directories that are never knowledge: build output, dependency trees, VCS
 * internals. Skipping them at the directory level is what keeps a scan of a
 * real workspace from being dominated by `node_modules`.
 */
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
  '.Trash',
  '.trash',
  '$RECYCLE.BIN',
  'System Volume Information'
])

/** Binary and generated files: indexing them costs time and returns noise. */
const IGNORED_EXTS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.a', '.lib',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tif', '.tiff',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.lock', '.pyc', '.class', '.jar', '.wasm', '.map',
  '.db', '.sqlite', '.sqlite3', '.pack', '.idx'
])

/** Parallel `stat` calls in flight. Tuned by measurement, not by feel. */
const STAT_CONCURRENCY = 64

/** Extensions whose content is worth putting in the full-text index. */
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.mdx', '.txt', '.rst', '.org', '.adoc',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.php',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.html', '.css', '.scss',
  '.csv', '.tsv', '.log', '.tex', '.bib'
])

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.claude')
}

export function isIgnoredFile(name: string): boolean {
  if (name.startsWith('.') && name !== '.gitignore' && name !== '.npmrc') return true
  return IGNORED_EXTS.has(path.extname(name).toLowerCase())
}

export function isTextFile(name: string): boolean {
  return TEXT_EXTS.has(path.extname(name).toLowerCase())
}

export interface WalkedFile {
  path: string
  root: string
  relPath: string
  name: string
  ext: string
  /** Top-level directory under the root; '' for a file at the root itself. */
  area: string
  size: number
  mtimeMs: number
}

export interface WalkOptions {
  roots: string[]
  /**
   * Depth guard against a pathological tree. Deliberately generous: unlike the
   * old MVP there is no *file* cap, because silently indexing part of a vault
   * is worse than taking longer to index all of it.
   */
  maxDepth?: number
  onWarning?(message: string): void
}

/**
 * Breadth-first walk of each root, yielding one file at a time.
 *
 * An async generator rather than a collected array: at 50k files, materialising
 * everything before writing anything is what forced the old implementation into
 * a file cap. Streaming lets the caller write in batches and keeps peak memory
 * flat regardless of vault size.
 *
 * Symlinks are followed but de-duplicated by real path, since an agent
 * workspace is full of links and a link pointing up its own tree would loop.
 */
export async function* walkRoots(opts: WalkOptions): AsyncGenerator<WalkedFile> {
  const maxDepth = opts.maxDepth ?? 24
  const warn = opts.onWarning ?? ((): void => {})
  const visited = new Set<string>()

  for (const root of opts.roots) {
    let realRoot: string
    try {
      realRoot = await fs.realpath(root)
    } catch {
      warn(`${root}: not readable, skipped`)
      continue
    }

    const queue: Array<{ dir: string; depth: number }> = [{ dir: realRoot, depth: 0 }]

    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) break
      const { dir, depth } = next

      if (visited.has(dir)) continue
      visited.add(dir)

      let entries: Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        // 系统设计文档 §9: one unreadable directory must not end the sweep.
        warn(`${dir}: ${(err as Error).message}`)
        continue
      }

      // Stat concurrently. The sweep is entirely I/O bound, and a serial stat
      // per entry was the single largest cost at 50k files - the OS will
      // happily service many at once.
      const statted = await mapWithConcurrency(entries, STAT_CONCURRENCY, async (entry) => {
        const full = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          return { entry, full, isDir: true, isFile: false, size: 0, mtimeMs: 0 }
        }

        // Decide to skip *before* paying for a stat: a vault full of images
        // should cost a readdir, not 50k syscalls.
        if (!entry.isSymbolicLink() && isIgnoredFile(entry.name)) return null

        try {
          const stat = await fs.stat(full)
          if (stat.isDirectory()) {
            return { entry, full, isDir: true, isFile: false, size: 0, mtimeMs: 0 }
          }
          if (!stat.isFile() || isIgnoredFile(entry.name)) return null
          return {
            entry,
            full,
            isDir: false,
            isFile: true,
            size: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs)
          }
        } catch {
          // A broken link or a file that vanished mid-walk is simply not there.
          return null
        }
      })

      for (const item of statted) {
        if (!item) continue

        if (item.isDir) {
          if (isIgnoredDir(item.entry.name) || depth >= maxDepth) continue
          try {
            queue.push({ dir: await fs.realpath(item.full), depth: depth + 1 })
          } catch {
            continue
          }
          continue
        }

        yield {
          path: item.full,
          root: realRoot,
          relPath: path.relative(realRoot, item.full),
          name: item.entry.name,
          ext: path.extname(item.entry.name).toLowerCase(),
          area: areaFor(realRoot, item.full),
          size: item.size,
          mtimeMs: item.mtimeMs
        }
      }
    }
  }
}

/** Bounded parallel map; preserves input order so the walk stays deterministic. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      const item = items[index]
      if (index >= items.length || item === undefined) return
      out[index] = await fn(item)
    }
  })

  await Promise.all(workers)
  return out
}

export function areaFor(root: string, file: string): string {
  const rel = path.relative(root, file)
  const [first] = rel.split(path.sep)
  return first && first !== rel ? first : ''
}
