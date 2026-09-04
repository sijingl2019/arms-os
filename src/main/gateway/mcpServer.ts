import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
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
 * The casts below are that mismatch and nothing else - keeping them here, and
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

  private http: HttpServer | undefined

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

    const http = createServer((req, res) => {
      void this.handle(req, res)
    })
    this.http = http

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        this.http = undefined
        reject(err.code === 'EADDRINUSE' ? portInUseError(this.port) : err)
      }
      http.once('error', onError)
      http.listen(this.port, HOST, () => {
        http.off('error', onError)
        resolve()
      })
    })

    return this.endpoint as string
  }

  /**
   * A fresh MCP server per request.
   *
   * This is the SDK's stateless pattern, and it is not optional: a
   * `StreamableHTTPServerTransport` tracks one response stream, so reusing a
   * single instance across requests fails on everything after the first. It
   * also means each request re-reads the registry, so a manifest reload takes
   * effect immediately and a removed tool really is gone.
   *
   * The low-level `Server` is used rather than `McpServer` on purpose. A
   * gateway proxies arbitrary tools carrying arbitrary JSON Schemas, whereas
   * `McpServer.registerTool` is built around hand-written Zod shapes - and when
   * handed no shape it invokes the callback with only the request extras, so
   * the tool's actual arguments never arrive.
   */
  private buildServer(): Server {
    const server = new Server(
      { name: 'arms-gateway', version: '0.1.0' },
      { capabilities: { tools: {} } }
    )

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.registry.tools().map((tool) => ({
        name: tool.qualifiedName,
        // The risk tier is visible to the agent so it can reason about it -
        // but the Gateway, not the agent, is what enforces it.
        description: `[${tool.risk}] ${tool.description}`.trim(),
        inputSchema: tool.inputSchema as { type: 'object' }
      }))
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {}
      try {
        const result = await this.dispatcher.call({
          qualifiedName: request.params.name,
          args: args as Record<string, unknown>
        })
        return { content: result.content, ...(result.isError ? { isError: true } : {}) }
      } catch (err) {
        // Report the refusal as a tool error rather than a protocol error: the
        // agent needs to read why it was stopped and adjust, not just see the
        // call fail.
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true
        }
      }
    })

    return server
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
    // Stateless means no server-initiated stream and no session to delete.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'this gateway is stateless; use POST' },
          id: null
        })
      )
      return
    }

    const server = this.buildServer()
    const transport = new StreamableHTTPServerTransport(
      sdkCompat<ConstructorParameters<typeof StreamableHTTPServerTransport>[0]>({
        sessionIdGenerator: undefined
      })
    )

    res.on('close', () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })

    try {
      await server.connect(sdkCompat<Transport>(transport))
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: (err as Error).message },
          id: null
        })
      )
    }
  }

  async stop(): Promise<void> {
    const http = this.http
    this.http = undefined
    if (http?.listening) {
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
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
