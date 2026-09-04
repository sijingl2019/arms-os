import { promises as fs } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  RISK_LEVELS,
  STRICTEST_RISK,
  type ConnectorTransport,
  type RiskLevel
} from './types'

/**
 * The connector manifest (Connector Gateway 设计文档 §3.4). A YAML file, kept
 * in the workspace and under version control - the same "truth lives in files"
 * rule the Skill and Memory layers follow.
 */

export interface ManifestToolDecl {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  risk?: RiskLevel
}

export interface ConnectorManifestEntry {
  id: string
  transport: ConnectorTransport
  /** argv for `cli` and `mcp-stdio`. */
  command?: string[]
  /** endpoint for `mcp-http`. */
  url?: string
  env?: Record<string, string>
  cwd?: string
  credentialRef?: string
  defaultRisk: RiskLevel
  /** Per-tool risk, overriding `defaultRisk`. */
  overrides: Record<string, RiskLevel>
  /**
   * Explicit tool declarations. Required for `cli`, which has no way to
   * introspect itself; optional for MCP transports, which can be asked.
   */
  tools: ManifestToolDecl[]
  enabled: boolean
  timeoutMs: number | null
}

export interface ManifestIssue {
  connectorId: string
  message: string
}

export interface LoadedManifest {
  entries: ConnectorManifestEntry[]
  /** Non-fatal problems. A bad entry is dropped, the rest still load. */
  issues: ManifestIssue[]
}

const TRANSPORTS: readonly ConnectorTransport[] = ['mcp-stdio', 'mcp-http', 'cli', 'browser']

function isRisk(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length === value.length ? out : undefined
}

function readOverrides(raw: unknown, id: string, issues: ManifestIssue[]): Record<string, RiskLevel> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ connectorId: id, message: 'overrides must be a mapping of tool name to risk' })
    return {}
  }

  const out: Record<string, RiskLevel> = {}
  for (const [tool, level] of Object.entries(raw as Record<string, unknown>)) {
    if (isRisk(level)) {
      out[tool] = level
    } else {
      // Fail safe rather than fail open: an unreadable label is the worst case.
      issues.push({
        connectorId: id,
        message: `override for "${tool}" is not a risk level; treating it as ${STRICTEST_RISK}`
      })
      out[tool] = STRICTEST_RISK
    }
  }
  return out
}

function readTools(raw: unknown, id: string, issues: ManifestIssue[]): ManifestToolDecl[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    issues.push({ connectorId: id, message: 'tools must be a list' })
    return []
  }

  const out: ManifestToolDecl[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const decl = item as Record<string, unknown>
    const name = typeof decl['name'] === 'string' ? decl['name'].trim() : ''
    if (!name) {
      issues.push({ connectorId: id, message: 'a tool entry has no name' })
      continue
    }
    const risk = decl['risk']
    if (risk !== undefined && !isRisk(risk)) {
      issues.push({
        connectorId: id,
        message: `tool "${name}" has an unrecognised risk; treating it as ${STRICTEST_RISK}`
      })
    }
    const schema = decl['input_schema'] ?? decl['inputSchema']
    out.push({
      name,
      ...(typeof decl['description'] === 'string' ? { description: decl['description'] } : {}),
      ...(typeof schema === 'object' && schema !== null
        ? { inputSchema: schema as Record<string, unknown> }
        : {}),
      ...(isRisk(risk) ? { risk } : risk !== undefined ? { risk: STRICTEST_RISK } : {})
    })
  }
  return out
}

/** Validate one raw YAML entry. Returns null when it cannot be used at all. */
export function parseEntry(raw: unknown, issues: ManifestIssue[]): ConnectorManifestEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push({ connectorId: '?', message: 'connector entry must be a mapping' })
    return null
  }
  const entry = raw as Record<string, unknown>
  const id = typeof entry['id'] === 'string' ? entry['id'].trim() : ''
  if (!id) {
    issues.push({ connectorId: '?', message: 'connector entry has no id' })
    return null
  }
  if (id.includes('.')) {
    // Tool names are `<connector>.<tool>`; a dot in the id makes them ambiguous.
    issues.push({ connectorId: id, message: 'connector id must not contain a dot' })
    return null
  }

  const transport = entry['transport']
  if (typeof transport !== 'string' || !(TRANSPORTS as readonly string[]).includes(transport)) {
    issues.push({
      connectorId: id,
      message: `transport must be one of ${TRANSPORTS.join(', ')}`
    })
    return null
  }

  const command = asStringArray(entry['command'])
  const url = typeof entry['url'] === 'string' ? entry['url'] : undefined

  if ((transport === 'cli' || transport === 'mcp-stdio') && (!command || command.length === 0)) {
    issues.push({ connectorId: id, message: `${transport} requires a command array` })
    return null
  }
  if (transport === 'mcp-http' && !url) {
    issues.push({ connectorId: id, message: 'mcp-http requires a url' })
    return null
  }

  const rawDefault = entry['default_risk'] ?? entry['defaultRisk']
  if (rawDefault !== undefined && !isRisk(rawDefault)) {
    issues.push({
      connectorId: id,
      message: `default_risk is not a risk level; treating it as ${STRICTEST_RISK}`
    })
  }
  // Omitting default_risk entirely also lands on the strictest tier: a
  // connector author must opt *down*, never accidentally opt out.
  const defaultRisk = isRisk(rawDefault) ? rawDefault : STRICTEST_RISK

  const tools = readTools(entry['tools'], id, issues)
  if (transport === 'cli' && tools.length === 0) {
    issues.push({
      connectorId: id,
      message: 'a cli connector cannot be introspected, so it must declare its tools'
    })
    return null
  }

  const credentialRef = entry['credential_ref'] ?? entry['credentialRef']
  const timeout = entry['timeout_ms'] ?? entry['timeoutMs']
  const env = entry['env']

  return {
    id,
    transport: transport as ConnectorTransport,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(typeof env === 'object' && env !== null
      ? { env: env as Record<string, string> }
      : {}),
    ...(typeof entry['cwd'] === 'string' ? { cwd: entry['cwd'] } : {}),
    ...(typeof credentialRef === 'string' ? { credentialRef } : {}),
    defaultRisk,
    overrides: readOverrides(entry['overrides'], id, issues),
    tools,
    enabled: entry['enabled'] !== false,
    timeoutMs: typeof timeout === 'number' ? timeout : null
  }
}

export function parseManifest(text: string): LoadedManifest {
  const issues: ManifestIssue[] = []
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (err) {
    return { entries: [], issues: [{ connectorId: '?', message: (err as Error).message }] }
  }

  if (doc === null || doc === undefined) return { entries: [], issues }

  // Accept both a bare list and `{ connectors: [...] }`.
  const list = Array.isArray(doc)
    ? doc
    : typeof doc === 'object' && Array.isArray((doc as Record<string, unknown>)['connectors'])
      ? ((doc as Record<string, unknown>)['connectors'] as unknown[])
      : null

  if (!list) {
    return {
      entries: [],
      issues: [{ connectorId: '?', message: 'manifest must be a list of connectors' }]
    }
  }

  const entries: ConnectorManifestEntry[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const entry = parseEntry(raw, issues)
    if (!entry) continue
    if (seen.has(entry.id)) {
      issues.push({ connectorId: entry.id, message: 'duplicate connector id, later entry ignored' })
      continue
    }
    seen.add(entry.id)
    entries.push(entry)
  }

  return { entries, issues }
}

/** A missing manifest is normal - it just means no connectors are configured. */
export async function loadManifest(file: string): Promise<LoadedManifest> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return { entries: [], issues: [] }
  }
  return parseManifest(text)
}

/** Effective risk for one tool: override beats declaration beats connector default. */
export function riskFor(entry: ConnectorManifestEntry, toolName: string): RiskLevel {
  const override = entry.overrides[toolName]
  if (override) return override
  const declared = entry.tools.find((t) => t.name === toolName)?.risk
  if (declared) return declared
  return entry.defaultRisk
}
