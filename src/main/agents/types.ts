import type { AgentId, SkillMeta } from '@shared/types'

export interface BuildContext {
  skill: SkillMeta
  /** Raw SKILL.md text, present only when the runtime asked for it. */
  skillBody?: string
  /** Free-form arguments appended to the prompt. */
  args?: string
  model?: string | null
  effort?: string | null
}

export interface CommandLine {
  command: string
  args: string[]
}

export interface AgentRuntime {
  id: AgentId
  /**
   * True when this runtime inlines SKILL.md into the prompt instead of letting
   * the CLI resolve the skill itself. The executor reads the file only then.
   */
  readonly needsSkillBody: boolean
  /** Translate a skill run into a concrete command line. */
  build(ctx: BuildContext): CommandLine
}

export type ExitReason = 'exit' | 'timeout' | 'cancelled' | 'spawn-error'

export interface ExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  reason: ExitReason
  /** Populated for `spawn-error`. */
  error?: string
}

export interface SpawnCallbacks {
  onStdout(chunk: string): void
  onStderr(chunk: string): void
  /** Called exactly once, whatever the outcome. */
  onExit(info: ExitInfo): void
}

export interface SpawnRequest extends CommandLine {
  cwd: string
  timeoutMs: number
}

export interface ProcessHandle {
  cancel(): void
}

/**
 * Injected into the executor so tests can drive the run state machine without
 * a real agent CLI on the machine.
 */
export type Spawner = (req: SpawnRequest, callbacks: SpawnCallbacks) => ProcessHandle

/** Human-readable command line, stored on the run record for audit. */
export function previewCommand({ command, args }: CommandLine): string {
  return [command, ...args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}
