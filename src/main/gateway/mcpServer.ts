import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Dispatcher } from './dispatcher'
import type { ConnectorRegistry } from './registry'
import { GatewayError } from './types'

/**
 * MCP over HTTP (Connector Gateway 设计文档 §3.1, §5).
 *
 * One endpoint, one address: Claude Code and Codex CLI both attach with
 *   claude mcp add --transport http arms-gateway http://127.0.0.1:39217/mcp
 *   codex  mcp add arms-gateway --url    http://127.0.0.1:39217/mcp
 * and neither learns how many real connectors sit behind it.
 */

export const DEFAULT_GATEWAY_PORT = 39217
/**
 * Loopback only, never 0.0.0.0 (§10.3). This endpoint performs privileged
 * actions with stored credentials; binding it to a LAN interface would hand
 * that to anything else on the network.
 */
const HOST = '127.0.0.1'
const MCP_PATH = '/mcp'

/**
 * The SDK's option and transport interfaces declare optional members without an
 * explicit `| undefined`, which `exactOptionalPropertyTypes` will not unify.
 * Both casts below are that mismatch and nothing else - keeping them here, and
 * only here, avoids relaxing the compiler option for the whole main process.
 */
const sdkCompat = <T,>(value: unknown): T => value as T

export interface McpGatewayServerOptions {
  registry: ConnectorRegistry
  dispatcher: Dispatcher
  port?: number
}

export class McpGatewayServer {
  private readonly registry: ConnectorRegistry
  private readonly dispatcher: Dispatcher
  private readonly port: number

  private http: Server | undefined
  private mcp: McpServer | undefined
  private transport: StreamableHTTPServerTransport | undefined
  private registered = new Set<string>()

  constructor({ registry, dispatcher, port }: McpGatewayServerOptions) {
    this.registry = registry
    this.dispatcher = dispatcher
    this.port = port ?? DEFAULT_GATEWAY_PORT
  }

  get endpoint(): string | null {
    return this.http?.listening ? `http://${HOST}:${this.port}${MCP_PATH}` : null
  }

  isRunning(): boolean {
    return this.http?.listening === true
  }

  async start(): Promise<string> {
    if (this.http?.listening) return this.endpoint as string

    const mcp = new McpServer({ name: 'arms-gateway', version: '0.1.0' })
    this.mcp = mcp
    this.syncTools()

    // Stateless: each agent process is its own short-lived client, and there is
    // no cross-request state worth the session bookkeeping.
    const transport = new StreamableHTTPServerTransport(
      sdkCompat<ConstructorParameters<typeof StreamableHTTPServerTransport>[0]>({
        sessionIdGenerator: undefined
      })
    )
    this.transport = transport
    await mcp.connect(sdkCompat<Transport>(transport))

    const http = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.http = http

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(this.port, HOST, () => {
        http.off('error', reject)
        resolve()
      })
    })

    return this.endpoint as string
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (path !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    // Belt and braces alongside the loopback bind: reject anything that did not
    // originate from this machine.
    if (req.socket.remoteAddress && !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('loopback only')
      return
    }

    try {
      await this.transport?.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end((err as Error).message)
    }
  }

  /**
   * Publish the registry's tools onto the MCP server.
   *
   * Called again after a manifest reload. The SDK has no "unregister", so a
   * tool that disappears is left registered and made to fail loudly rather than
   * silently routing to a connector that no longer exists.
   */
  syncTools(): void {
    const mcp = this.mcp
    if (!mcp) return

    for (const tool of this.registry.tools()) {
      if (this.registered.has(tool.qualifiedName)) continue
      this.registered.add(tool.qualifiedName)

      mcp.registerTool(
        tool.qualifiedName,
        {
          // The risk tier is part of the description so the agent can reason
          // about it too - though the Gateway, not the agent, enforces it.
          description: `[${tool.risk}] ${tool.description}`.trim(),
          inputSchema: undefined
        },
        async (args: unknown) => {
          const result = await this.dispatcher.call({
            qualifiedName: tool.qualifiedName,
            args: (args ?? {}) as Record<string, unknown>
          })
          return { content: result.content, ...(result.isError ? { isError: true } : {}) }
        }
      )
    }
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = undefined
    if (http?.listening) {
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
    try {
      await this.mcp?.close()
    } catch {
      /* already closed */
    }
    this.mcp = undefined
    this.transport = undefined
    this.registered = new Set()
  }
}

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/** Thrown when the fixed port is taken, usually by a second ARMS instance. */
export function portInUseError(port: number): GatewayError {
  return new GatewayError(
    'port_in_use',
    `127.0.0.1:${port} is already in use - another ARMS instance may be running`
  )
}
