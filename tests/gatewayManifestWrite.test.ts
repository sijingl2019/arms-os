import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendManifestEntry,
  parseManifest,
  removeManifestEntry
} from '@main/gateway/manifest'

let dir: string
let file: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arms-manifest-'))
  file = path.join(dir, 'connectors', 'manifest.yaml')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('manifest writes', () => {
  it('creates the file, appends, and round-trips through the loader', async () => {
    await appendManifestEntry(file, {
      id: 'email',
      transport: 'mcp-stdio',
      command: ['node', 'connectors/email-imap/server.js'],
      credential_ref: 'vault://email-imap',
      env: { IMAP_HOST: 'imap.gmail.com' },
      default_risk: 'read-only'
    })
    await appendManifestEntry(file, { id: 'other', transport: 'mcp-http', url: 'http://x/mcp' })

    const { entries, issues } = parseManifest(await fs.readFile(file, 'utf8'))
    expect(issues).toEqual([])
    expect(entries.map((e) => e.id)).toEqual(['email', 'other'])
    expect(entries[0]?.env).toEqual({ IMAP_HOST: 'imap.gmail.com' })
  })

  it('keeps hand-written comments when removing an entry', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# keep me\n- id: a\n  transport: mcp-http\n  url: http://a/mcp\n')
    await appendManifestEntry(file, { id: 'b', transport: 'mcp-http', url: 'http://b/mcp' })

    expect(await removeManifestEntry(file, 'a')).toBe(true)
    expect(await removeManifestEntry(file, 'nope')).toBe(false)

    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('# keep me')
    expect(parseManifest(text).entries.map((e) => e.id)).toEqual(['b'])
  })

  it('refuses the mapping form rather than writing invalid YAML', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'connectors:\n  - id: a\n    transport: mcp-http\n    url: http://a/mcp\n')
    await expect(
      appendManifestEntry(file, { id: 'b', transport: 'mcp-http', url: 'http://b/mcp' })
    ).rejects.toThrow(/手工编辑/)
  })
})
