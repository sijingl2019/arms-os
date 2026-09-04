/**
 * Connector Gateway internals (Connector Gateway 设计文档 §3.2, §4).
 *
 * The Gateway is the single enforcement point for anything that touches the
 * outside world. Skills describe intent; only this layer decides whether an
 * action actually happens.
 */

/**
 * Three tiers, per Connector Gateway 设计文档 §4:
 * - `read-only`        passes straight through
 * - `write-reversible` passes, but is flagged in the audit trail
 * - `write-irreversible` never runs without a human saying yes
 */
export type RiskLevel = 'read-only' | 'write-reversible' | 'write-irreversible'

/** Fail-safe default: an unlabelled tool is treated as the worst case. */
export const STRICTEST_RISK: RiskLevel = 'write-irreversible'

export const RISK_LEVELS: readonly RiskLevel[] = [
  'read-only',
  'write-reversible',
  'write-irreversible'
]

export type ConnectorTransport = 'mcp-stdio' | 'mcp-http' | 'cli' | 'browser'

export interface ToolSpec {
  /** Bare name inside its connector, e.g. `search_threads`. */
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>
  risk: RiskLevel
}

/** A tool as the agent sees it: `<connector>.<tool>`. */
export interface QualifiedTool extends ToolSpec {
  connectorId: string
  qualifiedName: string
}

export interface ToolResult {
  /** Text blocks, mirroring MCP's content shape. */
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface CallContext {
  connectorId: string
  toolName: string
  qualifiedName: string
  args: Record<string, unknown>
  risk: RiskLevel
  /** Correlates a Gateway call with the agent run that made it, when known. */
  runId: string | null
  /** MCP session that issued the call. */
  sessionId: string | null
  startedAt: Date
  /** Populated by the guardrail when a human was asked. */
  confirmationId?: string
  spec: ToolSpec
}

/** Koa-style: call `next()` to continue the chain, or short-circuit. */
export type Middleware = (ctx: CallContext, next: () => Promise<ToolResult>) => Promise<ToolResult>

/**
 * Transport-agnostic connector. Three implementations correspond to the three
 * Application-layer channels (架构规范 §7.1).
 */
export interface ConnectorAdapter {
  readonly id: string
  /** Tools this connector offers, already risk-labelled. */
  listTools(): Promise<ToolSpec[]>
  callTool(toolName: string, args: Record<string, unknown>, ctx: CallContext): Promise<ToolResult>
  /** Release any child process or client. Safe to call twice. */
  close(): Promise<void>
}

export class GatewayError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
  }
}

/** Rejected by a human, or auto-rejected when the request expired. */
export class ConfirmationDeniedError extends GatewayError {
  constructor(reason: string) {
    super('confirmation_denied', reason)
    this.name = 'ConfirmationDeniedError'
  }
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}
