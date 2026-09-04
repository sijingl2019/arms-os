import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmsBus } from '@main/bus'
import { loadConfig, type ArmsConfig } from '@main/config'
import { openDb, type Db } from '@main/db'
import { MemoryIndexer } from '@main/memory/indexer'
import { BEGIN, END, planRouterFiles, spliceBlock, writeRouterFiles } from '@main/memory/router'
import { MemoryStore } from '@main/memory/store'

/**
 * The router writer edits the user's own documents, so these tests are mostly
 * about what it must NOT do: never touch a byte outside its markers, never lose
 * hand-written prose, and never corrupt a file it has already written.
 */

let dir: string
let root: string
let routerRoot: string
let db: Db
let store: MemoryStore
let config: ArmsConfig
let indexer: MemoryIndexer

function write(rel: string, body: string): string {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body, 'utf8')
  return file
}

const masterPath = (): string => path.join(routerRoot, 'CLAUDE.md')
const read = (file: string): string => readFileSync(file, 'utf8')

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arms-router-'))
  root = path.join(dir, 'vault')
  routerRoot = path.join(dir, 'vault')
  mkdirSync(root, { recursive: true })

  db = openDb(':memory:')
  store = new MemoryStore(db)
  config = loadConfig({
    workspaceRoot: dir,
    stateDir: path.join(dir, 'state'),
    dbPath: ':memory:',
    memoryRoots: [root],
    memoryRouterRoot: routerRoot
  })
  indexer = new MemoryIndexer({ store, config, bus: new ArmsBus() })

  write('content/news.md', '# 每日资讯摘要\nbody')
  write('clients/acme.md', '# ACME')
  await indexer.refresh()
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

describe('spliceBlock', () => {
  it('creates from a template when the file does not exist', () => {
    const { contents, appended } = spliceBlock(null, 'BODY', '# Title')
    expect(contents).toContain('# Title')
    expect(contents).toContain(BEGIN)
    expect(contents).toContain('BODY')
    expect(appended).toBe(false)
  })

  it('replaces only what is between the markers', () => {
    const existing = `PROLOGUE\n\n${BEGIN}\nold\n${END}\n\nEPILOGUE\n`
    const { contents } = spliceBlock(existing, 'NEW', '# T')

    expect(contents.startsWith('PROLOGUE')).toBe(true)
    expect(contents.trimEnd().endsWith('EPILOGUE')).toBe(true)
    expect(contents).toContain('NEW')
    expect(contents).not.toContain('old')
  })

  it('appends rather than overwrites a file with no markers', () => {
    const { contents, appended } = spliceBlock('# My hand-written notes\n\nkeep me\n', 'BODY', '# T')
    expect(contents).toContain('keep me')
    expect(contents).toContain('BODY')
    expect(appended).toBe(true)
  })

  it('treats a half-marked file as unmarked instead of eating the rest of it', () => {
    // A stray BEGIN with no END would otherwise swallow everything after it.
    const existing = `intro\n${BEGIN}\ndangling\n\nimportant tail\n`
    const { contents, appended } = spliceBlock(existing, 'BODY', '# T')

    expect(appended).toBe(true)
    expect(contents).toContain('important tail')
    expect(contents).toContain('dangling')
  })

  it('is idempotent', () => {
    const once = spliceBlock(null, 'BODY', '# T').contents
    const twice = spliceBlock(once, 'BODY', '# T').contents
    expect(twice).toBe(once)
  })
})

describe('writeRouterFiles', () => {
  it('writes a master router listing every area', async () => {
    const written = await writeRouterFiles({ store, routerRoot })
    expect(written).toContain(masterPath())

    const master = read(masterPath())
    expect(master).toContain('工作领域索引')
    expect(master).toContain('content')
    expect(master).toContain('clients')
    expect(master).toContain('areas/CONTENT.md')
  })

  it('writes one domain index per area, pointing at its files', async () => {
    await writeRouterFiles({ store, routerRoot })
    const contentIndex = read(path.join(routerRoot, 'areas', 'CONTENT.md'))

    expect(contentIndex).toContain('content/news.md')
    // 架构规范 §5.1: a pointer, annotated with the document's own title.
    expect(contentIndex).toContain('每日资讯摘要')
  })

  it('preserves hand-written content above and below the block', async () => {
    writeFileSync(
      masterPath(),
      '# 我手写的主路由\n\n这段绝对不能被改掉。\n\n<!-- keep -->\n',
      'utf8'
    )
    await writeRouterFiles({ store, routerRoot })

    const master = read(masterPath())
    expect(master).toContain('这段绝对不能被改掉。')
    expect(master).toContain('<!-- keep -->')
    expect(master).toContain(BEGIN)
  })

  it('rewrites only the block on a second run, leaving prose intact', async () => {
    writeFileSync(masterPath(), `TOP\n\n${BEGIN}\nstale\n${END}\n\nBOTTOM\n`, 'utf8')
    await writeRouterFiles({ store, routerRoot })

    const master = read(masterPath())
    expect(master.startsWith('TOP')).toBe(true)
    expect(master.trimEnd().endsWith('BOTTOM')).toBe(true)
    expect(master).not.toContain('stale')
  })

  it('writes nothing the second time when the index has not changed', async () => {
    await writeRouterFiles({ store, routerRoot })
    const again = await writeRouterFiles({ store, routerRoot })
    expect(again).toEqual([])
  })

  it('reflects a removed area on the next write', async () => {
    await writeRouterFiles({ store, routerRoot })
    rmSync(path.join(root, 'clients'), { recursive: true, force: true })
    await indexer.refresh()
    await writeRouterFiles({ store, routerRoot })

    expect(read(masterPath())).not.toContain('areas/CLIENTS.md')
  })

  it('touches nothing on a dry run', async () => {
    const planned = await writeRouterFiles({ store, routerRoot, dryRun: true })
    expect(planned).toContain(masterPath())
    expect(() => read(masterPath())).toThrow()
  })

  it('reports which files a plan would change', async () => {
    const plans = await planRouterFiles({ store, routerRoot })
    expect(plans.every((p) => p.changed)).toBe(true)
    expect(plans.map((p) => path.basename(p.file)).sort()).toEqual([
      'CLAUDE.md',
      'CLIENTS.md',
      'CONTENT.md'
    ])
  })
})

describe('indexer router integration', () => {
  it('does not write router files unless asked', async () => {
    const result = await indexer.refresh({ force: true })
    expect(result.routerFiles).toEqual([])
    expect(() => read(masterPath())).toThrow()
  })

  it('writes them after the sweep has reconciled deletions', async () => {
    const result = await indexer.refresh({ force: true, writeRouter: true })
    expect(result.routerFiles).toContain(masterPath())
    expect(read(masterPath())).toContain('工作领域索引')
  })

  it('keeps a good index even if the router write fails', async () => {
    const broken = new MemoryIndexer({
      store,
      config: { ...config, memoryRouterRoot: path.join(root, 'content', 'news.md') },
      bus: new ArmsBus()
    })
    const result = await broken.refresh({ force: true, writeRouter: true })

    expect(result.updated).toBeGreaterThan(0)
    expect(result.warnings.join(' ')).toMatch(/router:/)
  })
})
