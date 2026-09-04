import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Spawner } from '@main/agents/types'
import { createCore, type ArmsCore } from '@main/core'
import { MemoryVault } from '@main/gateway/vault'
import type { PendingConfirmation } from '@shared/types'

/**
 * The real contract: an MCP client attaching over loopback HTTP, exactly the
 * way `claude mcp add --transport http` does, and finding that the guardrail
 * stands between it and a write-irreversible action.
 */

const MANIFEST = `
- id: demo
  transport: cli
  command: ["node", "connector.cjs"]
  default_risk: read-only
  tools:
    - name: search
      description: look something up
      input_schema:
        type: object
        required: [q]
        properties:
          q: { type: string }
    - name: publish
      description: post something irreversibly
      risk: write-irreversible
      input_schema:
        type: object
        properties:
          text: { type: string }
`

let dir: string
let core: ArmsCore
let endpoint: string
let client: Client | undefined
/** Ports are per-test so a leftover listener cannot poison the next one. */
let port = 39400

const spawner: Spawner = (req, cb) => {
  cb.onStdout(`ran ${req.args.slice(-2).join(' ')}`)
  cb.onExit({ code: 0, signal: null, reason: 'exit' })
  return { cancel: () => {} }
}

async function connect(): Promise<Client> {
  const c = new Client({ name: 'test-agent', version: '1.0.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(endpoint)) as never)
  client = c
  return c
}

beforeEach(async () => {
  port += 1
  dir = mkdtempSync(path.join(os.tmpdir(), 'arms-mcp-'))
  mkdirSync(path.join(dir, 'connectors'), { recursive: true })
  writeFileSync(path.join(dir, 'connectors', 'manifest.yaml'), MANIFEST, 'utf8')

  core = createCore({
    workspaceRoot: dir,
    stateDir: path.join(dir, 'state'),
    dbPath: ':memory:',
    scanRoots: [],
    spawner,
    vault: new MemoryVault(),
    gatewayPort: port
  })

  const started = await core.startGateway()
  endpoint = started.endpoint
})

afterEach(async () => {
  await client?.close().catch(() => {})
  client = undefined
  await core.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MCP over HTTP', () => {
  it('listens on loopback at the documented path', () => {
    expect(endpoint).toBe(`http://127.0.0.1:${port}/mcp`)
    // Never 0.0.0.0: the endpoint acts with stored credentials.
    expect(endpoint).not.toContain('0.0.0.0')
  })

  it('advertises every connector tool, namespaced and risk-labelled', async () => {
    const c = await connect()
    const { tools } = await c.listTools()
    const names = tools.map((t) => t.name).sort()

    expect(names).toEqual(['demo.publish', 'demo.search'])
    expect(tools.find((t) => t.name === 'demo.search')?.description).toContain('[read-only]')
    expect(tools.find((t) => t.name === 'demo.publish')?.description).toContain(
      '[write-irreversible]'
    )
  })

  it('passes a read-only call straight through to the connector', async () => {
    const c = await connect()
    const result = (await c.callTool({
      name: 'demo.search',
      arguments: { q: 'hello' }
    })) as { content: Array<{ text: string }> }

    expect(result.content[0]?.text).toContain('search')
    expect(core.gateway.confirmations.listPending()).toHaveLength(0)
  })

  it('records every call in the audit table', async () => {
    const c = await connect()
    await c.callTool({ name: 'demo.search', arguments: { q: 'hello' } })

    const rows = core.db
      .prepare('SELECT qualified_name, risk, outcome FROM tool_calls')
      .all() as Array<{ qualified_name: string; risk: string; outcome: string }>
    expect(rows).toEqual([
      { qualified_name: 'demo.search', risk: 'read-only', outcome: 'succeeded' }
    ])
  })

  it('holds a write-irreversible call until it is approved, then runs it', async () => {
    const c = await connect()
    const pending: PendingConfirmation[] = []
    core.bus.on('gateway:confirmation:pending', (e) => pending.push(e))

    const call = c.callTool({ name: 'demo.publish', arguments: { text: 'hi' } })

    // Give the request time to reach the guardrail and stop there.
    await new Promise((r) => setTimeout(r, 100))
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ qualifiedName: 'demo.publish', args: { text: 'hi' } })

    core.gateway.confirmations.approve(pending[0]!.confirmationId)

    const result = (await call) as { content: Array<{ text: string }> }
    expect(result.content[0]?.text).toContain('publish')
  })

  it('surfaces a rejection to the agent as an error, without calling the connector', async () => {
    const c = await connect()
    const call = c.callTool({ name: 'demo.publish', arguments: { text: 'hi' } })
    await new Promise((r) => setTimeout(r, 100))

    const id = core.gateway.confirmations.listPending()[0]!.confirmationId
    core.gateway.confirmations.reject(id, 'not this one')

    const result = (await call) as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/not this one/)

    const outcomes = core.db.prepare('SELECT outcome FROM tool_calls').all() as Array<{
      outcome: string
    }>
    expect(outcomes).toEqual([{ outcome: 'denied' }])
  })

  it('rejects a call whose arguments do not match the declared schema', async () => {
    const c = await connect()
    const result = (await c.callTool({ name: 'demo.search', arguments: {} })) as {
      isError?: boolean
      content: Array<{ text: string }>
    }
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/missing required/)
  })

  it('reports an unknown tool rather than silently doing nothing', async () => {
    const c = await connect()
    await expect(c.callTool({ name: 'demo.nope', arguments: {} })).rejects.toThrow()
  })

  it('reports its own status for the dashboard', () => {
    const status = core.gatewayStatus()
    expect(status).toMatchObject({
      running: true,
      endpoint,
      pendingConfirmations: 0,
      vault: { kind: 'memory', available: true }
    })
    expect(status.connectors).toEqual([
      { id: 'demo', transport: 'cli', enabled: true, toolCount: 2, error: null }
    ])
  })

  it('stops listening after shutdown', async () => {
    await core.gateway.stop()
    expect(core.gatewayStatus().running).toBe(false)
    await expect(
      fetch(endpoint, { method: 'POST' }).then(() => 'reachable')
    ).rejects.toBeTruthy()
  })
})
