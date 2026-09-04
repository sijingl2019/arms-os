import type { ConnectorManifestEntry } from '../manifest'
import { riskFor } from '../manifest'
import { GatewayError, type ConnectorAdapter, type ToolResult, type ToolSpec } from '../types'

/**
 * Application layer channel 4 (架构规范 §7.1): browser automation.
 *
 * Declared but deliberately not implemented. The spec calls this the last
 * resort - brittle, sensitive to platform anti-automation, and often against
 * the platform's terms - so it stays a stub until a connector genuinely has no
 * MCP, API or CLI route. Keeping the case here means the manifest can already
 * name it and get a clear error rather than "unknown transport".
 */
export class BrowserAdapter implements ConnectorAdapter {
  readonly id: string
  private readonly entry: ConnectorManifestEntry

  constructor(entry: ConnectorManifestEntry) {
    this.id = entry.id
    this.entry = entry
  }

  async listTools(): Promise<ToolSpec[]> {
    return this.entry.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object' },
      risk: riskFor(this.entry, tool.name)
    }))
  }

  async callTool(toolName: string): Promise<ToolResult> {
    throw new GatewayError(
      'transport_not_implemented',
      `${this.id}.${toolName} uses browser automation, which this build does not implement; ` +
        'prefer an official MCP server, an API, or a small CLI (架构规范 §7.1)'
    )
  }

  async close(): Promise<void> {}
}
