import type { Spawner } from '../agents/types'
import { BrowserAdapter } from './adapters/browser'
import { CliAdapter } from './adapters/cli'
import { McpPassthroughAdapter } from './adapters/mcpPassthrough'
import { loadManifest, riskFor, type ConnectorManifestEntry, type ManifestIssue } from './manifest'
import { GatewayError, type ConnectorAdapter, type QualifiedTool } from './types'
import { parseCredentialRef, type CredentialVault } from './vault'

export interface ConnectorState {
  entry: ConnectorManifestEntry
  adapter: ConnectorAdapter
  tools: QualifiedTool[]
  /** Set when the connector could not be reached during the last refresh. */
  error: string | null
}

export interface ConnectorRegistryOptions {
  manifestPath: string
  vault: CredentialVault
  defaultCwd: string
  spawner?: Spawner
}

/**
 * Loads the manifest and keeps one adapter per connector
 * (Connector Gateway 设计文档 §2.1).
 *
 * Tool names are namespaced `<connector>.<tool>` so two connectors can both
 * offer `search` without colliding, and so the agent's view stays stable when a
 * connector's implementation is swapped underneath it.
 */
export class ConnectorRegistry {
  private readonly options: ConnectorRegistryOptions
  private readonly states = new Map<string, ConnectorState>()
  private lastIssues: ManifestIssue[] = []

  constructor(options: ConnectorRegistryOptions) {
    this.options = options
  }

  /**
   * Re-read the manifest and rebuild the adapters. A connector that cannot be
   * reached is kept with its error recorded rather than dropped, so the
   * Dashboard can show why it is missing instead of it silently vanishing.
   */
  async refresh(): Promise<{ connectors: number; tools: number; issues: string[] }> {
    const { entries, issues } = await loadManifest(this.options.manifestPath)
    this.lastIssues = issues

    await this.closeAll()

    for (const entry of entries) {
      if (!entry.enabled) continue
      const adapter = this.buildAdapter(entry)
      const state: ConnectorState = { entry, adapter, tools: [], error: null }
      this.states.set(entry.id, state)

      try {
        const tools = await adapter.listTools()
        state.tools = tools.map((tool) => ({
          ...tool,
          // The manifest is the authority on risk even for a tool the
          // downstream server described itself.
          risk: riskFor(entry, tool.name),
          connectorId: entry.id,
          qualifiedName: `${entry.id}.${tool.name}`
        }))
      } catch (err) {
        state.error = (err as Error).message
      }
    }

    return {
      connectors: this.states.size,
      tools: this.tools().length,
      issues: [
        ...issues.map((i) => `${i.connectorId}: ${i.message}`),
        ...[...this.states.values()]
          .filter((s) => s.error !== null)
          .map((s) => `${s.entry.id}: ${s.error}`)
      ]
    }
  }

  private buildAdapter(entry: ConnectorManifestEntry): ConnectorAdapter {
    const credentialId = parseCredentialRef(entry.credentialRef)
    const credential = credentialId
      ? () => this.options.vault.get(credentialId)
      : undefined
    const defaultCwd = this.options.defaultCwd

    switch (entry.transport) {
      case 'cli':
        return new CliAdapter({
          entry,
          defaultCwd,
          ...(this.options.spawner ? { spawner: this.options.spawner } : {}),
          ...(credential ? { credential } : {})
        })
      case 'mcp-stdio':
      case 'mcp-http':
        return new McpPassthroughAdapter({
          entry,
          defaultCwd,
          ...(credential ? { credential } : {})
        })
      case 'browser':
        return new BrowserAdapter(entry)
    }
  }

  tools(): QualifiedTool[] {
    return [...this.states.values()]
      .flatMap((s) => s.tools)
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
  }

  /** Resolve `<connector>.<tool>`; throws when either half is unknown. */
  resolve(qualifiedName: string): { state: ConnectorState; tool: QualifiedTool } {
    const dot = qualifiedName.indexOf('.')
    if (dot <= 0) {
      throw new GatewayError(
        'unknown_tool',
        `tool names must be "<connector>.<tool>", got "${qualifiedName}"`
      )
    }
    const connectorId = qualifiedName.slice(0, dot)
    const state = this.states.get(connectorId)
    if (!state) throw new GatewayError('unknown_connector', `no connector: ${connectorId}`)

    const tool = state.tools.find((t) => t.qualifiedName === qualifiedName)
    if (!tool) throw new GatewayError('unknown_tool', `no tool: ${qualifiedName}`)
    return { state, tool }
  }

  list(): ConnectorState[] {
    return [...this.states.values()]
  }

  get(id: string): ConnectorState | undefined {
    return this.states.get(id)
  }

  issues(): string[] {
    return this.lastIssues.map((i) => `${i.connectorId}: ${i.message}`)
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.states.values()].map((s) =>
        s.adapter.close().catch(() => {
          /* closing a connector that already died is fine */
        })
      )
    )
    this.states.clear()
  }
}
