import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type {
  RunHistoryQuery,
  RunRecord,
  RunStatus,
  SkillMeta,
  SkillRunRequest
} from '@shared/types'
import type { ArmsBus } from '../bus'
import type { ArmsConfig } from '../config'
import { getRuntime } from '../agents/registry'
import { nodeSpawner } from '../agents/spawn'
import { previewCommand, type ExitInfo, type ProcessHandle, type Spawner } from '../agents/types'
import type { RunStore } from '../runs/store'
import type { SkillRegistry } from '../skills/registry'

export interface SkillExecutorDeps {
  registry: SkillRegistry
  runs: RunStore
  config: ArmsConfig
  bus: ArmsBus
  /** Overridden in tests so the state machine can be driven without a real CLI. */
  spawner?: Spawner
}

interface LiveRun {
  record: RunRecord
  handle: ProcessHandle
  output: string
}

function statusFor(info: ExitInfo): RunStatus {
  switch (info.reason) {
    case 'timeout':
      return 'timeout'
    case 'cancelled':
      return 'cancelled'
    case 'spawn-error':
      return 'failed'
    default:
      return info.code === 0 ? 'succeeded' : 'failed'
  }
}

/**
 * Turns a skill id into a running agent process and a durable run record
 * (系统设计文档 §6.1 场景 A).
 *
 * Deliberately out of scope: credentials and risk classification. Anything a
 * skill does to the outside world goes through the Connector Gateway, which is
 * the single enforcement point.
 */
export class SkillExecutor {
  private readonly registry: SkillRegistry
  private readonly runs: RunStore
  private readonly config: ArmsConfig
  private readonly bus: ArmsBus
  private readonly spawner: Spawner
  private readonly live = new Map<string, LiveRun>()
  private unsubscribe: (() => void) | undefined

  constructor({ registry, runs, config, bus, spawner }: SkillExecutorDeps) {
    this.registry = registry
    this.runs = runs
    this.config = config
    this.bus = bus
    this.spawner = spawner ?? nodeSpawner
  }

  /**
   * Subscribe to `routine:fired`. The Routine Scheduler, once it exists, only
   * has to emit that event - it never calls the executor directly.
   */
  start(): void {
    this.unsubscribe ??= this.bus.on('routine:fired', ({ routineId, target }) => {
      // Tool targets belong to ToolRoutineRunner; both listen, each takes its own.
      if (target.kind !== 'skill') return
      void this.run({
        skillId: target.skillId,
        routineId,
        trigger: 'routine',
        ...(target.args === null ? {} : { args: target.args }),
        ...(target.agent === null ? {} : { agent: target.agent }),
        ...(target.model === null ? {} : { model: target.model }),
        ...(target.effort === null ? {} : { effort: target.effort })
      }).catch(() => {
        /* the failure is already on the run record */
      })
    })
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const runId of [...this.live.keys()]) this.cancel(runId)
  }

  /**
   * Start a run and return its record immediately, in `running` state - the
   * caller follows progress through `skill:run:chunk` / `skill:run:completed`.
   */
  async run(req: SkillRunRequest): Promise<RunRecord> {
    const skill = this.registry.get(req.skillId)
    if (!skill) throw new Error(`unknown skill: ${req.skillId}`)

    const agentId = req.agent ?? this.config.defaultAgent
    const runtime = getRuntime(agentId)
    if (!runtime) throw new Error(`unknown agent: ${agentId}`)

    // The skill's own hints are the default model/effort tier (治理 §9).
    const model = req.model ?? skill.modelHint ?? null
    const effort = req.effort ?? skill.effortHint ?? null
    const cwd = req.cwd ?? this.config.workspaceRoot
    const timeoutMs = req.timeoutMs ?? this.config.defaultTimeoutMs

    const commandLine = runtime.build({
      skill,
      model,
      effort,
      ...(req.args === undefined ? {} : { args: req.args }),
      ...(runtime.needsSkillBody ? { skillBody: await this.readSkillBody(skill) } : {})
    })

    const record: RunRecord = {
      runId: randomUUID(),
      skillId: skill.id,
      routineId: req.routineId ?? null,
      label: this.labelFor(skill, req.args),
      trigger: req.trigger,
      agent: agentId,
      model,
      effort,
      cwd,
      command: previewCommand(commandLine),
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      output: '',
      error: null
    }

    // Written before the spawn, so a crash still leaves the attempt on record.
    this.runs.create(record)

    if (req.dryRun) {
      return this.settle(record, {
        status: 'succeeded',
        exitCode: 0,
        output: `[dry-run] ${record.command}`,
        error: null
      })
    }

    this.bus.emit('skill:run:started', { runId: record.runId, skillId: record.skillId })

    const entry: LiveRun = { record, handle: { cancel: () => {} }, output: '' }
    this.live.set(record.runId, entry)

    entry.handle = this.spawner(
      { ...commandLine, cwd, timeoutMs },
      {
        onStdout: (chunk) => this.appendChunk(entry, 'stdout', chunk),
        onStderr: (chunk) => this.appendChunk(entry, 'stderr', chunk),
        onExit: (info) => {
          this.live.delete(record.runId)
          this.settle(record, {
            status: statusFor(info),
            exitCode: info.code,
            output: entry.output,
            error: info.error ?? null
          })
        }
      }
    )

    return record
  }

  /** True if the run was live and a kill was issued. */
  cancel(runId: string): boolean {
    const entry = this.live.get(runId)
    if (!entry) return false
    entry.handle.cancel()
    return true
  }

  history(query: RunHistoryQuery = {}): RunRecord[] {
    return this.runs.list(query)
  }

  /** Startup reconciliation - see RunStore.markInterrupted. */
  reconcile(): number {
    return this.runs.markInterrupted()
  }

  private labelFor(skill: SkillMeta, args?: string): string {
    const suffix = args?.trim()
    return suffix ? `${skill.id} ${suffix}` : skill.id
  }

  private async readSkillBody(skill: SkillMeta): Promise<string> {
    try {
      return await fs.readFile(skill.path, 'utf8')
    } catch (err) {
      throw new Error(`cannot read ${skill.path}: ${(err as Error).message}`)
    }
  }

  private appendChunk(entry: LiveRun, stream: 'stdout' | 'stderr', chunk: string): void {
    // Keep only the tail: a chatty skill must not be able to bloat the db.
    entry.output = (entry.output + chunk).slice(-this.config.outputCapBytes)
    this.bus.emit('skill:run:chunk', { runId: entry.record.runId, stream, chunk })
  }

  private settle(
    record: RunRecord,
    result: { status: RunStatus; exitCode: number | null; output: string; error: string | null }
  ): RunRecord {
    const endedAt = new Date().toISOString()
    const saved =
      this.runs.finish(record.runId, { ...result, endedAt }) ??
      { ...record, ...result, endedAt, durationMs: 0 }

    void this.runs.appendLog(saved)
    this.bus.emit('skill:run:completed', {
      runId: saved.runId,
      skillId: saved.skillId,
      routineId: saved.routineId,
      status: saved.status,
      exitCode: saved.exitCode,
      endedAt
    })
    return saved
  }
}
