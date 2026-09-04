import os from 'node:os'
import path from 'node:path'
import type { AgentId, SkillSource } from '@shared/types'

export interface SkillScanRoot {
  /** Absolute directory whose immediate subdirectories each hold a SKILL.md. */
  dir: string
  source: SkillSource
}

export interface ArmsConfig {
  /** Default cwd for skill runs, and the root of `<workspace>/.claude/skills`. */
  workspaceRoot: string
  /** Where the OS keeps its own state (db, logs). Not the workspace. */
  stateDir: string
  /**
   * Scanned in order; a later root overrides an earlier one on an id clash, so
   * `workspace` must come last.
   */
  scanRoots: SkillScanRoot[]
  dbPath: string
  /** Human-readable mirror of the runs table (架构规范 §6.2). */
  runLogPath: string
  /** Destination for the generated SKILLS_INDEX.md (架构规范 §4.3). */
  skillsIndexPath: string
  /** Connector manifest YAML, kept in the workspace under version control. */
  connectorManifestPath: string
  /** How long a write-irreversible tool call blocks waiting for a human. */
  confirmationTimeoutMs: number
  /** Loopback port for the MCP endpoint agents attach to. */
  gatewayPort: number
  /**
   * Knowledge-base directories to index. Separate from `workspaceRoot`: the
   * vault is rarely the code workspace. Empty means nothing is indexed.
   */
  memoryRoots: string[]
  /**
   * Where the generated router files (`CLAUDE.md`, `areas/*.md`) are written.
   * Defaults to the first memory root, never the code workspace - the router
   * writer must not rewrite this repository's own hand-written CLAUDE.md.
   */
  memoryRouterRoot: string | null
  /** Bytes of each text file fed to the full-text index. */
  memoryExcerptBytes: number
  /** Files larger than this are indexed by metadata only. */
  memoryMaxFileBytes: number
  defaultAgent: AgentId
  defaultTimeoutMs: number
  /** Per-run cap on retained stdout+stderr, so a chatty skill cannot bloat the db. */
  outputCapBytes: number
}

const TEN_MINUTES = 10 * 60 * 1000
const FIVE_MINUTES = 5 * 60 * 1000

export interface ConfigOverrides extends Partial<ArmsConfig> {}

/**
 * Environment beats defaults, explicit overrides beat both. Overrides exist for
 * tests and for the CLI's `--workspace` flag.
 */
export function loadConfig(overrides: ConfigOverrides = {}): ArmsConfig {
  const workspaceRoot = path.resolve(
    overrides.workspaceRoot ?? process.env.ARMS_WORKSPACE ?? process.cwd()
  )
  const stateDir = path.resolve(
    overrides.stateDir ?? process.env.ARMS_STATE_DIR ?? path.join(os.homedir(), '.arms-os')
  )

  const base: ArmsConfig = {
    workspaceRoot,
    stateDir,
    scanRoots: defaultScanRoots(workspaceRoot),
    dbPath: path.join(stateDir, 'arms-os.db'),
    runLogPath: path.join(stateDir, 'runs.log'),
    skillsIndexPath: path.join(workspaceRoot, '.claude', 'skills', 'SKILLS_INDEX.md'),
    connectorManifestPath: path.join(workspaceRoot, 'connectors', 'manifest.yaml'),
    confirmationTimeoutMs: FIVE_MINUTES,
    gatewayPort: 39217,
    memoryRoots: memoryRootsFromEnv(),
    memoryRouterRoot: null,
    memoryExcerptBytes: 8_192,
    memoryMaxFileBytes: 2 * 1024 * 1024,
    defaultAgent: 'claude',
    defaultTimeoutMs: TEN_MINUTES,
    outputCapBytes: 16_000
  }

  const merged = { ...base, ...overrides, workspaceRoot, stateDir }
  // Resolve the router root only after overrides, so an explicit setting wins
  // and the default still tracks whichever roots ended up configured.
  if (merged.memoryRouterRoot === null && merged.memoryRoots.length > 0) {
    merged.memoryRouterRoot = merged.memoryRoots[0] ?? null
  }
  return merged
}

/** `ARMS_MEMORY_ROOTS`, path-separator delimited. */
function memoryRootsFromEnv(): string[] {
  const raw = process.env['ARMS_MEMORY_ROOTS']
  if (!raw) return []
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry))
}

/** User-level first, workspace last - workspace wins on a name clash. */
export function defaultScanRoots(workspaceRoot: string): SkillScanRoot[] {
  const userDir = path.join(os.homedir(), '.claude', 'skills')
  const workspaceDir = path.join(workspaceRoot, '.claude', 'skills')
  const roots: SkillScanRoot[] = [{ dir: userDir, source: 'user' }]
  if (path.resolve(workspaceDir) !== path.resolve(userDir)) {
    roots.push({ dir: workspaceDir, source: 'workspace' })
  }
  return roots
}
