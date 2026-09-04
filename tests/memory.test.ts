import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmsBus } from '@main/bus'
import { loadConfig, type ArmsConfig } from '@main/config'
import { openDb, type Db } from '@main/db'
import { MemoryIndexer } from '@main/memory/indexer'
import { MemoryStore } from '@main/memory/store'
import { areaFor, isIgnoredDir, isIgnoredFile, isTextFile, walkRoots } from '@main/memory/walk'

let dir: string
let root: string
let db: Db
let store: MemoryStore
let bus: ArmsBus
let config: ArmsConfig
let indexer: MemoryIndexer

function write(rel: string, body: string): string {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body, 'utf8')
  return file
}

/** Move a file's mtime so a sweep sees it as changed without altering size. */
function touch(file: string, secondsFromNow: number): void {
  const when = new Date(Date.now() + secondsFromNow * 1000)
  utimesSync(file, when, when)
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arms-mem-'))
  root = path.join(dir, 'vault')
  mkdirSync(root, { recursive: true })

  db = openDb(':memory:')
  store = new MemoryStore(db)
  bus = new ArmsBus()
  config = loadConfig({
    workspaceRoot: dir,
    stateDir: path.join(dir, 'state'),
    dbPath: ':memory:',
    memoryRoots: [root],
    memoryRouterRoot: path.join(dir, 'router')
  })
  indexer = new MemoryIndexer({ store, config, bus })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

describe('walk rules', () => {
  it('ignores dependency and VCS directories', () => {
    for (const name of ['node_modules', '.git', 'dist', '__pycache__']) {
      expect(isIgnoredDir(name)).toBe(true)
    }
    expect(isIgnoredDir('areas')).toBe(false)
    // .claude holds skills, so it is the one dotdir worth walking.
    expect(isIgnoredDir('.claude')).toBe(false)
  })

  it('ignores binaries but keeps text', () => {
    expect(isIgnoredFile('photo.png')).toBe(true)
    expect(isIgnoredFile('app.exe')).toBe(true)
    expect(isIgnoredFile('notes.md')).toBe(false)
    expect(isTextFile('notes.md')).toBe(true)
    expect(isTextFile('archive.zip')).toBe(false)
  })

  it('derives an area from the top-level folder', () => {
    expect(areaFor('/v', path.join('/v', 'content', 'a.md'))).toBe('content')
    expect(areaFor('/v', path.join('/v', 'a.md'))).toBe('')
  })

  it('walks nested files and skips ignored trees', async () => {
    write('content/a.md', 'a')
    write('content/deep/b.md', 'b')
    write('node_modules/pkg/c.md', 'c')
    write('top.md', 'top')

    const seen: string[] = []
    for await (const file of walkRoots({ roots: [root] })) seen.push(file.relPath)

    expect(seen.map((p) => p.split(path.sep).join('/')).sort()).toEqual([
      'content/a.md',
      'content/deep/b.md',
      'top.md'
    ])
  })

  it('reports an unreadable root as a warning instead of throwing', async () => {
    const warnings: string[] = []
    const seen = []
    for await (const f of walkRoots({
      roots: [path.join(dir, 'nope')],
      onWarning: (m) => warnings.push(m)
    })) {
      seen.push(f)
    }
    expect(seen).toHaveLength(0)
    expect(warnings[0]).toMatch(/not readable/)
  })
})

describe('MemoryIndexer incremental sweep', () => {
  it('indexes everything on the first pass', async () => {
    write('content/a.md', '# Alpha\nsome text')
    write('clients/b.md', '# Beta')

    const result = await indexer.refresh()
    expect(result).toMatchObject({ added: 2, updated: 0, removed: 0, unchanged: 0 })
    expect(store.count()).toBe(2)
  })

  it('re-reads nothing when the vault has not changed', async () => {
    write('content/a.md', '# Alpha')
    await indexer.refresh()

    const second = await indexer.refresh()
    expect(second).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 1 })
  })

  it('picks up an edit and re-indexes only that file', async () => {
    write('content/a.md', '# Alpha')
    write('content/b.md', '# Beta')
    await indexer.refresh()

    const edited = write('content/a.md', '# Alpha renamed with more words')
    touch(edited, 5)

    const result = await indexer.refresh()
    expect(result).toMatchObject({ added: 0, updated: 1, unchanged: 1 })
    expect(store.get(edited)?.title).toBe('Alpha renamed with more words')
  })

  it('drops files that disappeared', async () => {
    write('content/a.md', 'a')
    const gone = write('content/gone.md', 'g')
    await indexer.refresh()

    rmSync(gone)
    const result = await indexer.refresh()

    expect(result.removed).toBe(1)
    expect(store.get(gone)).toBeUndefined()
    expect(store.count()).toBe(1)
  })

  it('re-reads everything when forced', async () => {
    write('content/a.md', '# Alpha')
    await indexer.refresh()

    const result = await indexer.refresh({ force: true })
    expect(result).toMatchObject({ updated: 1, unchanged: 0 })
  })

  it('refuses to run two sweeps at once', async () => {
    write('content/a.md', 'a')
    const first = indexer.refresh()
    await expect(indexer.refresh()).rejects.toThrow(/already running/)
    await first
  })

  it('does nothing when no memory root is configured', async () => {
    const empty = new MemoryIndexer({
      store,
      config: loadConfig({ workspaceRoot: dir, dbPath: ':memory:', memoryRoots: [] }),
      bus
    })
    await expect(empty.refresh()).resolves.toMatchObject({ added: 0, unchanged: 0 })
  })

  it('reports progress and completion on the bus', async () => {
    for (let i = 0; i < 300; i += 1) write(`content/f${i}.md`, `file ${i}`)

    const phases: string[] = []
    bus.on('memory:index:progress', (e) => phases.push(e.phase))
    let completed = 0
    bus.on('memory:index:completed', () => (completed += 1))

    await indexer.refresh()
    expect(phases).toContain('scanning')
    expect(phases).toContain('writing')
    expect(completed).toBe(1)
  })

  it('summarises areas', async () => {
    write('content/a.md', 'a')
    write('content/b.md', 'b')
    write('clients/c.md', 'c')
    await indexer.refresh()

    expect(store.areas()).toEqual([
      expect.objectContaining({ area: 'content', files: 2 }),
      expect.objectContaining({ area: 'clients', files: 1 })
    ])
  })
})

describe('MemoryStore search', () => {
  beforeEach(async () => {
    write('content/news.md', '# 每日资讯摘要\n每天早上抓取指定信源，生成一份精简的摘要。')
    write('content/deploy.md', '# Deployment runbook\nRestart the gateway and verify health.')
    write('clients/acme.md', '# ACME\nRenewal discussion scheduled for next quarter.')
    await indexer.refresh()
  })

  it('finds an English phrase in file content', () => {
    const hits = indexer.search({ query: 'gateway' })
    expect(hits.map((h) => h.name)).toContain('deploy.md')
  })

  it('finds a Chinese substring in file content', () => {
    // The reason the index uses trigram: unicode61 cannot match this at all.
    const hits = indexer.search({ query: '抓取指定' })
    expect(hits.map((h) => h.name)).toContain('news.md')
  })

  it('matches a title', () => {
    expect(indexer.search({ query: 'Deployment' }).map((h) => h.name)).toContain('deploy.md')
  })

  it('filters by area', () => {
    const hits = indexer.search({ query: 'e', area: 'clients' })
    expect(hits.every((h) => h.area === 'clients')).toBe(true)
  })

  it('falls back for a query too short for a trigram, instead of returning nothing', () => {
    // Two Chinese characters cannot be a trigram; the LIKE fallback covers it.
    const hits = indexer.search({ query: 'ac' })
    expect(hits.map((h) => h.name)).toContain('acme.md')
  })

  it('returns nothing for a blank query rather than everything', () => {
    expect(indexer.search({ query: '   ' })).toEqual([])
  })

  it('treats FTS punctuation as literal text, not syntax', () => {
    expect(() => indexer.search({ query: '"unbalanced AND (' })).not.toThrow()
  })

  it('honours the limit', () => {
    expect(indexer.search({ query: 'e', limit: 1 }).length).toBeLessThanOrEqual(1)
  })

  it('drops a deleted file out of search results', async () => {
    const file = path.join(root, 'content', 'deploy.md')
    rmSync(file)
    await indexer.refresh()
    expect(indexer.search({ query: 'gateway' }).map((h) => h.name)).not.toContain('deploy.md')
  })
})
