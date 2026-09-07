import type { GatewayStatus, RiskLevel, ToolCallOutcome, ToolCallRecord } from '@shared/types'
import type { Spawner } from '../agents/types'
import type { ArmsBus } from '../bus'
import type { ArmsConfig } from '../config'
import type { Db } from '../db'
import { ConfirmationStore } from './confirmations'
import { Dispatcher } from './dispatcher'
import { McpGatewayServer } from './mcpServer'
import { ConnectorRegistry } from './registry'
import { compact, pruneToolCalls, type PruneResult } from './retention'
import { parseCredentialRef, RefusingVault, type CredentialVault } from './vault'

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
interface ToolCallRow {
  call_id: string
  connector_id: string
  tool_name: string
  qualified_name: string
  args: string
  risk: string
  outcome: string
  confirmation_id: string | null
  run_id: string | null
  session_id: string | null
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  result: string | null
  error: string | null
}

function toToolCall(row: ToolCallRow): ToolCallRecord {
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.args)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    /* a row written by an older build is still worth showing */
  }

  return {
    callId: row.call_id,
    connectorId: row.connector_id,
    toolName: row.tool_name,
    qualifiedName: row.qualified_name,
    args,
    risk: row.risk as RiskLevel,
    outcome: row.outcome as ToolCallOutcome,
    confirmationId: row.confirmation_id,
    runId: row.run_id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    result: row.result,
    error: row.error
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

export class ConnectorGateway {
  readonly registry: ConnectorRegistry
  readonly confirmations: ConfirmationStore
  readonly dispatcher: Dispatcher
  readonly vault: CredentialVault

  private readonly server: McpGatewayServer
  private readonly db: Db
  private pruneTimer: NodeJS.Timeout | undefined
  /**
   * Ids currently in the vault, refreshed whenever the manifest is read.
   * `status()` is synchronous and the vault is not, so presence is snapshotted
   * rather than awaited per call.
   */
  private storedCredentials: string[] = []
  private readonly config: ArmsConfig
  private lastIssues: string[] = []

  constructor({ db, bus, config, vault, spawner, port }: ConnectorGatewayOptions) {
    this.db = db
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
  async start(): Promise<{
    endpoint: string
    expired: number
    issues: string[]
    pruned: PruneResult
  }> {
    const expired = this.confirmations.expireStale()
    // Once at startup, then daily. A long-running instance would otherwise
    // never prune, and a short-lived one would never get the chance.
    const pruned = this.prune()
    if (!this.pruneTimer) {
      this.pruneTimer = setInterval(() => this.prune(), DAY_MS)
      this.pruneTimer.unref?.()
    }
    const refresh = await this.registry.refresh()
    this.lastIssues = refresh.issues
    this.storedCredentials = await this.vault.list().catch(() => [])

    const endpoint = await this.server.start()
    return { endpoint, expired, issues: refresh.issues, pruned }
  }

  /** Apply the audit-trail retention policy. Safe to call at any time. */
  prune(now = new Date()): PruneResult {
    return pruneToolCalls(
      this.db,
      {
        keepDays: this.config.toolCallKeepDays,
        keepReadOnlyDays: this.config.toolCallKeepReadOnlyDays
      },
      now
    )
  }

  /**
   * Reclaim the disk the pruned rows were using. Rewrites the whole file, so
   * this is a command the user runs, never something on a timer.
   */
  compact(): { before: number; after: number } {
    return compact(this.db)
  }

  /**
   * Re-read the manifest. The HTTP server keeps running: it builds its tool
   * list per request, so the new manifest is live on the very next call.
   */
  async reload(): Promise<string[]> {
    const refresh = await this.registry.refresh()
    this.lastIssues = refresh.issues
    this.storedCredentials = await this.vault.list().catch(() => [])
    return refresh.issues
  }

  /**
   * Which credentials the manifest asks for, and whether each one is stored.
   *
   * Presence only: this is what lets the panel say "gmail-oauth is missing"
   * without a secret ever reaching the renderer.
   */
  private credentialStatus(): Array<{ id: string; connectorIds: string[]; present: boolean }> {
    const wanted = new Map<string, string[]>()
    for (const state of this.registry.list()) {
      const id = parseCredentialRef(state.entry.credentialRef)
      if (!id) continue
      wanted.set(id, [...(wanted.get(id) ?? []), state.entry.id])
    }
    return [...wanted].map(([id, connectorIds]) => ({
      id,
      connectorIds,
      present: this.storedCredentials.includes(id)
    }))
  }

  /**
   * Recent audit rows, mapped into the shared shape.
   *
   * The mapping is the point: handing raw snake_case rows to the renderer
   * typed as `ToolCallRecord` compiles fine and then renders "Invalid Date"
   * and "undefinedms", because nothing checks a shape that was never converted.
   */
  recentCalls(limit = 100): ToolCallRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM tool_calls ORDER BY started_at DESC LIMIT ?')
      .all(limit) as ToolCallRow[]
    return rows.map(toToolCall)
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
      pendingConfirmations: this.confirmations.pendingCount(),
      retention: {
        keepDays: this.config.toolCallKeepDays,
        keepReadOnlyDays: this.config.toolCallKeepReadOnlyDays
      },
      toolCallCount: (
        this.db.prepare('SELECT count(*) AS n FROM tool_calls').get() as { n: number }
      ).n,
      credentials: this.credentialStatus()
    }
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = undefined
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
export * from './retention'
export * from './vault'
export * from './types'
