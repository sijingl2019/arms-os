/**
 * Memory Indexer benchmark against a synthetic 50k-file vault.
 *
 * The scale problem is the entire reason this module exists, so the numbers
 * belong in the repo rather than in a commit message. Run with:
 *   npm run bench:memory            (50k files)
 *   BENCH_FILES=5000 npm run bench:memory
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ArmsBus } from '../src/main/bus'
import { loadConfig } from '../src/main/config'
import { openDb } from '../src/main/db'
import { MemoryIndexer } from '../src/main/memory/indexer'
import { MemoryStore } from '../src/main/memory/store'

const FILES = Number(process.env.BENCH_FILES ?? 50000)
const dir = mkdtempSync(path.join(os.tmpdir(), 'arms-bench-'))
const root = path.join(dir, 'vault')

// Build a vault shaped like a real one: a few areas, nested folders, mixed
// Chinese/English prose, plus a chunk of binaries the walker should skip.
process.stdout.write(`generating ${FILES} files… `)
const areas = ['content', 'clients', 'finance', 'research', 'archive']
const madeDirs = new Set<string>()
const ensure = (d: string) => { if (!madeDirs.has(d)) { mkdirSync(d, { recursive: true }); madeDirs.add(d) } }
let made = 0
for (let i = 0; i < FILES; i++) {
  const area = areas[i % areas.length] as string
  const sub = `${Math.floor(i / 500)}`
  const d = path.join(root, area, sub)
  ensure(d)
  const body = i % 7 === 0
    ? `# 每日资讯摘要 ${i}\n\n每天早上抓取指定信源，生成一份精简的资讯摘要。编号 ${i}。\n${'补充说明。'.repeat(40)}`
    : `# Note ${i}\n\nDeployment runbook and gateway notes for record ${i}.\n${'lorem ipsum dolor sit amet. '.repeat(40)}`
  writeFileSync(path.join(d, `n${i}.md`), body, 'utf8')
  made++
}
// Binaries + a node_modules tree the walker must skip cheaply.
for (let i = 0; i < 2000; i++) {
  const d = path.join(root, 'assets', `${Math.floor(i / 500)}`)
  ensure(d)
  writeFileSync(path.join(d, `img${i}.png`), Buffer.alloc(256))
}
mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
for (let i = 0; i < 2000; i++) writeFileSync(path.join(root, 'node_modules', 'pkg', `m${i}.js`), 'x')
console.log('done')

const dbPath = path.join(dir, 'bench.db')
const db = openDb(dbPath)
const store = new MemoryStore(db)
const config = loadConfig({ workspaceRoot: dir, stateDir: path.join(dir,'state'), dbPath, memoryRoots: [root] })
const indexer = new MemoryIndexer({ store, config, bus: new ArmsBus() })

// Event-loop lag sampler: this is what decides whether a worker thread is
// actually needed, rather than assumed.
let maxLag = 0, samples = 0, totalLag = 0
let last = process.hrtime.bigint()
const sampler = setInterval(() => {
  const now = process.hrtime.bigint()
  const lag = Number(now - last) / 1e6 - 20
  if (lag > 0) { maxLag = Math.max(maxLag, lag); totalLag += lag; samples++ }
  last = now
}, 20)

const t1 = Date.now()
const first = await indexer.refresh()
const firstMs = Date.now() - t1
clearInterval(sampler)

console.log(`\nFIRST   ${firstMs}ms  added=${first.added} skipped=${first.skipped} warnings=${first.warnings.length}`)
console.log(`LAG     max=${maxLag.toFixed(0)}ms avg=${samples ? (totalLag/samples).toFixed(1) : 0}ms over ${samples} samples`)

const t2 = Date.now()
const second = await indexer.refresh()
console.log(`RESCAN  ${Date.now()-t2}ms  unchanged=${second.unchanged} added=${second.added} updated=${second.updated}`)

// One file edited out of 50k
const target = path.join(root, 'content', '0', 'n0.md')
writeFileSync(target, '# 改过的文件\n新的内容在这里。', 'utf8')
utimesSync(target, new Date(Date.now()+5000), new Date(Date.now()+5000))
const t3 = Date.now()
const third = await indexer.refresh()
console.log(`1-EDIT  ${Date.now()-t3}ms  updated=${third.updated} unchanged=${third.unchanged}`)

for (const q of ['抓取指定', 'gateway notes', '资讯摘要', 'n4242']) {
  const t = Date.now()
  const hits = indexer.search({ query: q, limit: 20 })
  console.log(`SEARCH  ${String(Date.now()-t).padStart(4)}ms  ${hits.length} hits  "${q}"`)
}

const size = db.prepare('SELECT page_count*page_size AS b FROM pragma_page_count(), pragma_page_size()').get() as {b:number}
console.log(`ROWS    ${store.count()}   DB ${(size.b/1024/1024).toFixed(1)} MB   vault files generated ${made}`)
db.close()
rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
