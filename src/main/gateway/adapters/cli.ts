import { nodeSpawner } from '../../agents/spawn'
import type { Spawner } from '../../agents/types'
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

export interface CliAdapterOptions {
  entry: ConnectorManifestEntry
  /** Reused from the Skill Executor so process handling stays in one place. */
  spawner?: Spawner
  /** Resolved plaintext credential, if the manifest declared one. */
  credential?: () => Promise<string>
  defaultCwd: string
}

/**
 * Application layer channel 3 (架构规范 §7.1): a self-built CLI.
 *
 * The tool name becomes the first argument and the arguments object is passed
 * as one JSON string, so a connector script only has to parse argv[2]. A CLI
 * cannot describe itself, so its tools come from the manifest.
 */
export class CliAdapter implements ConnectorAdapter {
  readonly id: string
  private readonly entry: ConnectorManifestEntry
  private readonly spawner: Spawner
  private readonly credential: (() => Promise<string>) | undefined
  private readonly defaultCwd: string

  constructor({ entry, spawner, credential, defaultCwd }: CliAdapterOptions) {
    this.id = entry.id
    this.entry = entry
    this.spawner = spawner ?? nodeSpawner
    this.credential = credential
    this.defaultCwd = defaultCwd
  }

  async listTools(): Promise<ToolSpec[]> {
    return this.entry.tools.map((tool) => ({
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
    const command = this.entry.command
    if (!command || command.length === 0) {
      throw new GatewayError('connector_misconfigured', `${this.id} has no command`)
    }

    const [bin, ...rest] = command
    if (bin === undefined) {
      throw new GatewayError('connector_misconfigured', `${this.id} has an empty command`)
    }

    // Decrypt as late as possible, and only into the child's environment -
    // never onto the command line, where it would land in the audit log.
    const env: Record<string, string> = { ...(this.entry.env ?? {}) }
    if (this.credential) env['ARMS_CREDENTIAL'] = await this.credential()

    const timeoutMs = this.entry.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const spawnArgs = [...rest, toolName, JSON.stringify(args)]

    return new Promise<ToolResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''

      this.spawner(
        {
          command: bin,
          args: spawnArgs,
          cwd: this.entry.cwd ?? this.defaultCwd,
          timeoutMs,
          ...(Object.keys(env).length > 0 ? { env } : {})
        },
        {
          onStdout: (chunk) => {
            stdout += chunk
          },
          onStderr: (chunk) => {
            stderr += chunk
          },
          onExit: (info) => {
            if (info.reason === 'timeout') {
              reject(
                new GatewayError('connector_timeout', `${this.id}.${toolName} timed out after ${timeoutMs}ms`)
              )
              return
            }
            if (info.reason === 'spawn-error') {
              reject(
                new GatewayError('connector_unavailable', `${this.id}: ${info.error ?? 'spawn failed'}`)
              )
              return
            }
            if (info.code !== 0) {
              resolve(textResult(stderr.trim() || stdout.trim() || `exit ${info.code}`, true))
              return
            }
            resolve(textResult(stdout.trim()))
          }
        }
      )
    })
  }

  async close(): Promise<void> {
    // Each call is its own short-lived process; nothing is held open.
  }
}
