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
  defaultAgent: AgentId
  defaultTimeoutMs: number
  /** Per-run cap on retained stdout+stderr, so a chatty skill cannot bloat the db. */
  outputCapBytes: number
}

const TEN_MINUTES = 10 * 60 * 1000

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
    defaultAgent: 'claude',
    defaultTimeoutMs: TEN_MINUTES,
    outputCapBytes: 16_000
  }

  return { ...base, ...overrides, workspaceRoot, stateDir }
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
