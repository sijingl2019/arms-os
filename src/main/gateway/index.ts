import type { GatewayStatus } from '@shared/types'
import type { Spawner } from '../agents/types'
import type { ArmsBus } from '../bus'
import type { ArmsConfig } from '../config'
import type { Db } from '../db'
import { ConfirmationStore } from './confirmations'
import { Dispatcher } from './dispatcher'
import { McpGatewayServer } from './mcpServer'
import { ConnectorRegistry } from './registry'
import { RefusingVault, type CredentialVault } from './vault'

export interface ConnectorGatewayOptions {
  db: Db
  bus: ArmsBus
  config: ArmsConfig
  /** Defaults to the refusing vault, which is correct outside Electron. */
  vault?: CredentialVault
  spawner?: Spawner
  port?: number
}

/**
 * Assembles the Connector Gateway and owns its lifecycle.
 *
 * The one invariant worth restating: every route to the outside world runs
 * through `Dispatcher.call`, so the guardrail cannot be bypassed by any other
 * module reaching a connector directly (系统设计文档 §10).
 */
export class ConnectorGateway {
  readonly registry: ConnectorRegistry
  readonly confirmations: ConfirmationStore
  readonly dispatcher: Dispatcher
  readonly vault: CredentialVault

  private readonly server: McpGatewayServer
  private readonly config: ArmsConfig
  private lastIssues: string[] = []

  constructor({ db, bus, config, vault, spawner, port }: ConnectorGatewayOptions) {
    this.config = config
    this.vault = vault ?? new RefusingVault()

    this.registry = new ConnectorRegistry({
      manifestPath: config.connectorManifestPath,
      vault: this.vault,
      defaultCwd: config.workspaceRoot,
      ...(spawner ? { spawner } : {})
    })

    this.confirmations = new ConfirmationStore(db, bus)

    this.dispatcher = new Dispatcher({
      registry: this.registry,
      confirmations: this.confirmations,
      db,
      bus,
      confirmationTimeoutMs: config.confirmationTimeoutMs
    })

    this.server = new McpGatewayServer({
      registry: this.registry,
      dispatcher: this.dispatcher,
      ...(port === undefined ? {} : { port })
    })
  }

  /**
   * Load the manifest and begin listening. Any confirmation left pending by a
   * previous session is expired first - nothing is waiting on it any more, so
   * it could never be answered.
   */
  async start(): Promise<{ endpoint: string; expired: number; issues: string[] }> {
    const expired = this.confirmations.expireStale()
    const refresh = await this.registry.refresh()
    this.lastIssues = refresh.issues

    const endpoint = await this.server.start()
    return { endpoint, expired, issues: refresh.issues }
  }

  /**
   * Re-read the manifest. The HTTP server keeps running: it builds its tool
   * list per request, so the new manifest is live on the very next call.
   */
  async reload(): Promise<string[]> {
    const refresh = await this.registry.refresh()
    this.lastIssues = refresh.issues
    return refresh.issues
  }

  status(): GatewayStatus {
    return {
      running: this.server.isRunning(),
      endpoint: this.server.endpoint,
      manifestPath: this.config.connectorManifestPath,
      connectors: this.registry.list().map((state) => ({
        id: state.entry.id,
        transport: state.entry.transport,
        enabled: state.entry.enabled,
        toolCount: state.tools.length,
        error: state.error
      })),
      tools: this.registry.tools().map((tool) => ({
        connectorId: tool.connectorId,
        toolName: tool.name,
        qualifiedName: tool.qualifiedName,
        description: tool.description,
        risk: tool.risk
      })),
      issues: this.lastIssues,
      vault: { kind: this.vault.kind, available: this.vault.isAvailable() },
      pendingConfirmations: this.confirmations.pendingCount()
    }
  }

  async stop(): Promise<void> {
    // Release blocked callers before tearing down, so no agent is left holding
    // a request that can never be answered.
    this.confirmations.releaseAll()
    await this.server.stop()
    await this.registry.closeAll()
  }
}

export { ConfirmationStore } from './confirmations'
export { Dispatcher } from './dispatcher'
export { ConnectorRegistry } from './registry'
export { DEFAULT_GATEWAY_PORT } from './mcpServer'
export * from './vault'
export * from './types'
