import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ConnectorManifestEntry } from '../manifest'
import { riskFor } from '../manifest'
import {
  GatewayError,
  textResult,
  type CallContext,
  type ConnectorAdapter,
  type ToolResult,
  type ToolSpec
} from '../types'

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * The SDK declares several transport members as optional without an explicit
 * `| undefined`, which `exactOptionalPropertyTypes` refuses to unify with its
 * own `Transport` interface. The concrete classes are what `connect` is built
 * for, so the mismatch is narrowed here rather than by relaxing the compiler
 * option for the whole main process.
 */
type TransportLike = StdioClientTransport | StreamableHTTPClientTransport

interface RemoteTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface RemoteContent {
  type?: string
  text?: string
}

export interface McpPassthroughOptions {
  entry: ConnectorManifestEntry
  credential?: () => Promise<string>
  defaultCwd: string
}

/**
 * Application layer channel 1 and 2 (架构规范 §7.1): an official MCP server,
 * over stdio or HTTP.
 *
 * The downstream server is spoken to with the official client SDK and its
 * results are passed through untouched. What this layer adds is the risk label:
 * a downstream tool has no idea whether it is dangerous, so the manifest says.
 */
export class McpPassthroughAdapter implements ConnectorAdapter {
  readonly id: string
  private readonly entry: ConnectorManifestEntry
  private readonly credential: (() => Promise<string>) | undefined
  private readonly defaultCwd: string

  private client: Client | undefined
  private connecting: Promise<Client> | undefined

  constructor({ entry, credential, defaultCwd }: McpPassthroughOptions) {
    this.id = entry.id
    this.entry = entry
    this.credential = credential
    this.defaultCwd = defaultCwd
  }

  /** Connect lazily and once: a connector nobody calls costs nothing. */
  private async connect(): Promise<Client> {
    if (this.client) return this.client
    this.connecting ??= this.open().catch((err: unknown) => {
      // Let the next call retry instead of caching the failure forever.
      this.connecting = undefined
      throw err
    })
    this.client = await this.connecting
    return this.client
  }

  private async open(): Promise<Client> {
    const transport = await this.buildTransport()
    const client = new Client({ name: 'arms-gateway', version: '0.1.0' })
    try {
      await client.connect(transport as unknown as Transport)
    } catch (err) {
      throw new GatewayError(
        'connector_unavailable',
        `${this.id} could not be reached: ${(err as Error).message}`
      )
    }
    return client
  }

  private async buildTransport(): Promise<TransportLike> {
    const secret = this.credential ? await this.credential() : undefined

    if (this.entry.transport === 'mcp-http') {
      if (!this.entry.url) {
        throw new GatewayError('connector_misconfigured', `${this.id} has no url`)
      }
      return new StreamableHTTPClientTransport(new URL(this.entry.url), {
        ...(secret
          ? { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }
          : {})
      })
    }

    const command = this.entry.command
    const [bin, ...args] = command ?? []
    if (bin === undefined) {
      throw new GatewayError('connector_misconfigured', `${this.id} has no command`)
    }

    return new StdioClientTransport({
      command: bin,
      args,
      cwd: this.entry.cwd ?? this.defaultCwd,
      env: {
        ...(this.entry.env ?? {}),
        ...(secret ? { ARMS_CREDENTIAL: secret } : {})
      }
    })
  }

  /**
   * Ask the downstream server what it offers, then label each tool. A tool the
   * manifest never mentions still gets a risk level - the connector default,
   * which itself defaults to the strictest tier.
   */
  async listTools(): Promise<ToolSpec[]> {
    const client = await this.connect()
    const response = (await client.listTools()) as { tools?: RemoteTool[] }
    return (response.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object' },
      risk: riskFor(this.entry, tool.name)
    }))
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: CallContext
  ): Promise<ToolResult> {
    const client = await this.connect()
    const timeout = this.entry.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const response = (await client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout
    })) as { content?: RemoteContent[]; isError?: boolean }

    const content = (response.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => ({ type: 'text' as const, text: block.text as string }))

    if (content.length === 0) {
      return textResult(JSON.stringify(response.content ?? null), response.isError === true)
    }
    return { content, ...(response.isError === true ? { isError: true } : {}) }
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.connecting = undefined
    if (!client) return
    try {
      await client.close()
    } catch {
      /* a downstream that is already gone is not an error worth surfacing */
    }
  }
}
