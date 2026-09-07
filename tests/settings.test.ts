import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type ArmsCore } from '@main/core'
import { SETTING_KEYS } from '@main/settings'
import { skillDoc } from './helpers'

/**
 * Knowledge roots chosen in the UI, rather than only through an environment
 * variable. What matters is that the choice survives a restart and that
 * dropping a root actually removes its files from search.
 */

let dir: string
let vaultA: string
let vaultB: string
let core: ArmsCore

function note(root: string, rel: string, body: string): void {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body, 'utf8')
}

function open(dbPath: string): ArmsCore {
  return createCore({
    workspaceRoot: dir,
    stateDir: path.join(dir, 'state'),
    dbPath,
    scanRoots: [],
    memoryRoots: []
  })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'arms-settings-'))
  vaultA = path.join(dir, 'vault-a')
  vaultB = path.join(dir, 'vault-b')
  mkdirSync(vaultA, { recursive: true })
  mkdirSync(vaultB, { recursive: true })
  note(vaultA, 'content/alpha.md', '# Alpha\ngateway notes')
  note(vaultB, 'content/beta.md', '# Beta\nrunbook notes')
  writeFileSync(path.join(dir, 'skill-placeholder.md'), skillDoc({ name: 'x' }), 'utf8')
  core = open(':memory:')
})

afterEach(async () => {
  await core.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

describe('memory roots as a stored setting', () => {
  it('starts with none when neither env nor setting supplies one', () => {
    expect(core.indexer.status().roots).toEqual([])
  })

  it('accepts a root and indexes it', async () => {
    core.setMemoryRoots([vaultA])
    expect(core.indexer.status().roots).toEqual([vaultA])

    await core.indexer.refresh()
    expect(core.indexer.search({ query: 'gateway' }).map((h) => h.name)).toContain('alpha.md')
  })

  it('resolves and de-duplicates the paths it stores', () => {
    const result = core.setMemoryRoots([vaultA, vaultA, path.join(vaultA, '.', '')])
    expect(result.roots).toEqual([vaultA])
  })

  it('defaults the router root to the first folder', () => {
    core.setMemoryRoots([vaultA, vaultB])
    expect(core.indexer.status().routerRoot).toBe(vaultA)
  })

  it('drops a removed root out of search rather than leaving it findable', async () => {
    core.setMemoryRoots([vaultA, vaultB])
    await core.indexer.refresh()
    expect(core.indexer.search({ query: 'runbook' })).toHaveLength(1)

    const result = core.setMemoryRoots([vaultA])

    // A sweep only reconciles the roots it walks, so removal has to prune here.
    expect(result.pruned).toBeGreaterThan(0)
    expect(core.indexer.search({ query: 'runbook' })).toEqual([])
    expect(core.indexer.search({ query: 'gateway' })).toHaveLength(1)
  })
})

describe('persistence across a restart', () => {
  it('remembers the chosen roots', async () => {
    const dbPath = path.join(dir, 'state', 'arms.db')
    await core.close()

    core = open(dbPath)
    core.setMemoryRoots([vaultA])
    await core.close()

    core = open(dbPath)
    expect(core.indexer.status().roots).toEqual([vaultA])
  })

  it('lets a stored choice outrank the environment', async () => {
    const dbPath = path.join(dir, 'state', 'arms2.db')
    await core.close()

    core = open(dbPath)
    core.setMemoryRoots([vaultB])
    await core.close()

    // A later run configured with a different root via config still honours
    // what the user picked, which an env var alone could not express.
    core = createCore({
      workspaceRoot: dir,
      stateDir: path.join(dir, 'state'),
      dbPath,
      scanRoots: [],
      memoryRoots: [vaultA]
    })
    expect(core.indexer.status().roots).toEqual([vaultB])
  })

  it('stores the list under a stable key', async () => {
    core.setMemoryRoots([vaultA])
    expect(core.settings.getList(SETTING_KEYS.memoryRoots)).toEqual([vaultA])
  })
})
