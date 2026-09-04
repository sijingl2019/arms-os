import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseManifest, riskFor } from '@main/gateway/manifest'
import { ConnectorRegistry } from '@main/gateway/registry'
import { MemoryVault, RefusingVault, parseCredentialRef } from '@main/gateway/vault'
import type { Spawner } from '@main/agents/types'

const GMAIL = `
- id: gmail
  transport: mcp-stdio
  command: ["npx", "-y", "@modelcontextprotocol/server-gmail"]
  credential_ref: vault://gmail-oauth
  default_risk: read-only
  overrides:
    send_message: write-reversible
    trash_message: write-irreversible
`

describe('parseManifest', () => {
  it('reads the shape from the design doc', () => {
    const { entries, issues } = parseManifest(GMAIL)
    expect(issues).toEqual([])
    expect(entries[0]).toMatchObject({
      id: 'gmail',
      transport: 'mcp-stdio',
      credentialRef: 'vault://gmail-oauth',
      defaultRisk: 'read-only',
      enabled: true
    })
  })

  it('resolves per-tool risk: override beats declaration beats connector default', () => {
    const entry = parseManifest(GMAIL).entries[0]!
    expect(riskFor(entry, 'search_threads')).toBe('read-only')
    expect(riskFor(entry, 'send_message')).toBe('write-reversible')
    expect(riskFor(entry, 'trash_message')).toBe('write-irreversible')
  })

  it('treats a connector with no default_risk as the strictest tier', () => {
    // Fail safe: forgetting to label something must make the system ask more.
    const { entries } = parseManifest(`
- id: mystery
  transport: cli
  command: ["node", "x.js"]
  tools:
    - name: doit
`)
    expect(entries[0]?.defaultRisk).toBe('write-irreversible')
    expect(riskFor(entries[0]!, 'doit')).toBe('write-irreversible')
  })

  it('treats an unrecognised risk label as the strictest tier, and says so', () => {
    const { entries, issues } = parseManifest(`
- id: x
  transport: cli
  command: ["node", "x.js"]
  default_risk: totally-safe
  tools:
    - name: doit
      risk: harmless
`)
    expect(entries[0]?.defaultRisk).toBe('write-irreversible')
    expect(riskFor(entries[0]!, 'doit')).toBe('write-irreversible')
    expect(issues.map((i) => i.message).join(' ')).toMatch(/not a risk level|unrecognised risk/)
  })

  it('rejects a cli connector that does not declare its tools', () => {
    const { entries, issues } = parseManifest(`
- id: silent
  transport: cli
  command: ["node", "x.js"]
`)
    expect(entries).toHaveLength(0)
    expect(issues[0]?.message).toMatch(/must declare its tools/)
  })

  it('rejects a connector id containing a dot, which would break tool naming', () => {
    const { entries, issues } = parseManifest(`
- id: my.connector
  transport: mcp-http
  url: http://127.0.0.1:1/mcp
`)
    expect(entries).toHaveLength(0)
    expect(issues[0]?.message).toMatch(/must not contain a dot/)
  })

  it.each([
    ['mcp-stdio without a command', '- id: a\n  transport: mcp-stdio\n'],
    ['mcp-http without a url', '- id: a\n  transport: mcp-http\n'],
    ['an unknown transport', '- id: a\n  transport: carrier-pigeon\n']
  ])('drops %s', (_label, yaml) => {
    expect(parseManifest(yaml).entries).toHaveLength(0)
  })

  it('keeps the good entries when one is broken', () => {
    const { entries, issues } = parseManifest(`${GMAIL}
- id: broken
  transport: nonsense
`)
    expect(entries.map((e) => e.id)).toEqual(['gmail'])
    expect(issues).toHaveLength(1)
  })

  it('ignores a duplicate id rather than letting it shadow the first', () => {
    const { entries, issues } = parseManifest(`${GMAIL}
- id: gmail
  transport: mcp-http
  url: http://127.0.0.1:1/mcp
`)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.transport).toBe('mcp-stdio')
    expect(issues[0]?.message).toMatch(/duplicate/)
  })

  it('accepts both a bare list and a connectors: mapping', () => {
    const wrapped = parseManifest(`connectors:\n${GMAIL}`)
    expect(wrapped.entries).toHaveLength(1)
  })

  it('reports malformed YAML instead of throwing', () => {
    const { entries, issues } = parseManifest('- id: [unclosed\n')
    expect(entries).toHaveLength(0)
    expect(issues).toHaveLength(1)
  })
})

describe('parseCredentialRef', () => {
  it('unwraps a vault reference and ignores anything else', () => {
    expect(parseCredentialRef('vault://gmail-oauth')).toBe('gmail-oauth')
    expect(parseCredentialRef('gmail-oauth')).toBeNull()
    expect(parseCredentialRef(undefined)).toBeNull()
  })
})

describe('RefusingVault', () => {
  it('refuses loudly rather than falling back to something weaker', async () => {
    const vault = new RefusingVault()
    expect(vault.isAvailable()).toBe(false)
    await expect(vault.get('x')).rejects.toThrow(/desktop app/)
    await expect(vault.set('x', 'y')).rejects.toThrow(/desktop app/)
    expect(await vault.has('x')).toBe(false)
  })
})

describe('ConnectorRegistry', () => {
  let dir: string
  let manifestPath: string
  let registry: ConnectorRegistry
  let spawnedEnv: Record<string, string> | undefined

  const spawner: Spawner = (req, cb) => {
    spawnedEnv = req.env
    cb.onStdout(JSON.stringify({ ok: true, args: req.args }))
    cb.onExit({ code: 0, signal: null, reason: 'exit' })
    return { cancel: () => {} }
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'arms-gw-'))
    mkdirSync(path.join(dir, 'connectors'), { recursive: true })
    manifestPath = path.join(dir, 'connectors', 'manifest.yaml')
    spawnedEnv = undefined
  })

  afterEach(async () => {
    await registry?.closeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  function build(vault = new MemoryVault()): ConnectorRegistry {
    registry = new ConnectorRegistry({ manifestPath, vault, defaultCwd: dir, spawner })
    return registry
  }

  it('namespaces tools as <connector>.<tool>', async () => {
    writeFileSync(
      manifestPath,
      `
- id: weibo
  transport: cli
  command: ["node", "cli.js"]
  default_risk: write-irreversible
  tools:
    - name: publish
      description: post to weibo
    - name: search
      risk: read-only
`,
      'utf8'
    )

    await build().refresh()
    expect(registry.tools().map((t) => t.qualifiedName)).toEqual([
      'weibo.publish',
      'weibo.search'
    ])
    expect(registry.tools().map((t) => t.risk)).toEqual(['write-irreversible', 'read-only'])
  })

  it('is a no-op when no manifest exists', async () => {
    const result = await build().refresh()
    expect(result).toMatchObject({ connectors: 0, tools: 0 })
  })

  it('skips a disabled connector', async () => {
    writeFileSync(
      manifestPath,
      `
- id: weibo
  transport: cli
  enabled: false
  command: ["node", "cli.js"]
  tools: [{ name: publish }]
`,
      'utf8'
    )
    await build().refresh()
    expect(registry.tools()).toHaveLength(0)
  })

  it('rejects an unqualified or unknown tool name', async () => {
    await build().refresh()
    expect(() => registry.resolve('publish')).toThrow(/<connector>\.<tool>/)
    expect(() => registry.resolve('weibo.publish')).toThrow(/no connector/)
  })

  it('passes a credential through the environment, never the command line', async () => {
    writeFileSync(
      manifestPath,
      `
- id: weibo
  transport: cli
  command: ["node", "cli.js"]
  credential_ref: vault://weibo-cookie
  default_risk: read-only
  tools: [{ name: search }]
`,
      'utf8'
    )
    const vault = new MemoryVault()
    await vault.set('weibo-cookie', 'super-secret')

    const reg = build(vault)
    await reg.refresh()
    const { state, tool } = reg.resolve('weibo.search')
    await state.adapter.callTool(tool.name, { q: 'hi' }, {
      connectorId: 'weibo',
      toolName: 'search',
      qualifiedName: 'weibo.search',
      args: {},
      risk: 'read-only',
      runId: null,
      sessionId: null,
      startedAt: new Date(),
      spec: tool
    })

    // The secret must reach the child, but never appear in an audited argv.
    expect(spawnedEnv?.['ARMS_CREDENTIAL']).toBe('super-secret')
  })

  it('reports a browser connector as unimplemented rather than pretending', async () => {
    writeFileSync(
      manifestPath,
      `
- id: legacy
  transport: browser
  default_risk: write-irreversible
  tools: [{ name: click }]
`,
      'utf8'
    )
    const reg = build()
    await reg.refresh()
    const { state, tool } = reg.resolve('legacy.click')
    await expect(
      state.adapter.callTool(tool.name, {}, {
        connectorId: 'legacy',
        toolName: 'click',
        qualifiedName: 'legacy.click',
        args: {},
        risk: 'write-irreversible',
        runId: null,
        sessionId: null,
        startedAt: new Date(),
        spec: tool
      })
    ).rejects.toThrow(/does not implement/)
  })
})
