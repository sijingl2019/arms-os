import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmsBus } from '@main/bus'
import { SkillExecutor } from '@main/executor'
import { RunStore } from '@main/runs/store'
import { SkillRegistry } from '@main/skills/registry'
import type { ExitInfo, SpawnCallbacks, SpawnRequest, Spawner } from '@main/agents/types'
import type { RunStatus } from '@shared/types'
import { createHarness, skillDoc, type Harness } from './helpers'

/** Records what was spawned and hands the test the process's exit lever. */
function fakeSpawner(): {
  spawner: Spawner
  calls: SpawnRequest[]
  readonly cancelled: number
  emitStdout(chunk: string): void
  exit(info: Partial<ExitInfo>): void
} {
  const calls: SpawnRequest[] = []
  const state = { cancelled: 0 }
  let callbacks: SpawnCallbacks | undefined

  const spawner: Spawner = (req, cb) => {
    calls.push(req)
    callbacks = cb
    return {
      cancel: () => {
        state.cancelled += 1
        cb.onExit({ code: null, signal: 'SIGTERM', reason: 'cancelled' })
      }
    }
  }

  return {
    spawner,
    calls,
    get cancelled() {
      return state.cancelled
    },
    emitStdout: (chunk) => callbacks?.onStdout(chunk),
    exit: (info) => callbacks?.onExit({ code: 0, signal: null, reason: 'exit', ...info })
  }
}

const DEFAULT_DOC = skillDoc({
  name: 'news-digest',
  modelHint: 'claude-sonnet-5',
  effortHint: 'medium'
})

let h: Harness
let bus: ArmsBus
let registry: SkillRegistry
let runs: RunStore
let fake: ReturnType<typeof fakeSpawner>
let executor: SkillExecutor

async function setup(doc = DEFAULT_DOC): Promise<void> {
  h.writeSkill('workspace', 'news-digest', doc)
  await registry.refresh()
}

beforeEach(() => {
  h = createHarness()
  bus = new ArmsBus()
  registry = new SkillRegistry({ db: h.db, config: h.config, bus })
  runs = new RunStore({ db: h.db, logPath: h.config.runLogPath })
  fake = fakeSpawner()
  executor = new SkillExecutor({ registry, runs, config: h.config, bus, spawner: fake.spawner })
})

afterEach(async () => {
  executor.stop()
  // The log write is fire-and-forget by design, so drain it before the temp
  // directory is removed.
  await runs.flush()
  h.db.close()
  h.cleanup()
})

describe('SkillExecutor.run', () => {
  it('rejects an unknown skill', async () => {
    await expect(executor.run({ skillId: 'nope', trigger: 'cli' })).rejects.toThrow(/unknown skill/)
  })

  it('builds a claude slash command, defaulting model and effort from the skill hints', async () => {
    await setup()
    await executor.run({ skillId: 'news-digest', trigger: 'dashboard' })

    expect(fake.calls[0]).toMatchObject({
      command: 'claude',
      args: ['-p', '/news-digest', '--model', 'claude-sonnet-5', '--effort', 'medium'],
      cwd: h.config.workspaceRoot,
      timeoutMs: h.config.defaultTimeoutMs
    })
  })

  it('lets an explicit model and effort override the hints', async () => {
    await setup()
    await executor.run({
      skillId: 'news-digest',
      trigger: 'cli',
      model: 'claude-opus-5',
      effort: 'high'
    })

    expect(fake.calls[0]?.args).toEqual([
      '-p',
      '/news-digest',
      '--model',
      'claude-opus-5',
      '--effort',
      'high'
    ])
  })

  it('omits the flags a skill gives no hint for', async () => {
    await setup(skillDoc({ name: 'news-digest' }))
    await executor.run({ skillId: 'news-digest', trigger: 'cli' })
    expect(fake.calls[0]?.args).toEqual(['-p', '/news-digest'])
  })

  it('appends args to the prompt', async () => {
    await setup()
    await executor.run({ skillId: 'news-digest', trigger: 'cli', args: 'since yesterday' })
    expect(fake.calls[0]?.args[1]).toBe('/news-digest since yesterday')
  })

  it('inlines SKILL.md for the codex runtime', async () => {
    await setup()
    await executor.run({ skillId: 'news-digest', trigger: 'cli', agent: 'codex' })

    const [subcommand, prompt] = fake.calls[0]?.args ?? []
    expect(fake.calls[0]?.command).toBe('codex')
    expect(subcommand).toBe('exec')
    expect(prompt).toContain('BEGIN news-digest SKILL.md')
    expect(prompt).toContain('绝对不能做的事')
  })

  it('records the run as running before anything is spawned', async () => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'dashboard' })

    const stored = runs.get(record.runId)
    expect(stored).toMatchObject({
      status: 'running',
      skillId: 'news-digest',
      trigger: 'dashboard',
      agent: 'claude',
      endedAt: null
    })
    expect(stored?.command).toContain('claude -p')
  })

  it('settles as succeeded on exit code 0 and keeps the output', async () => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'cli' })

    fake.emitStdout('hello ')
    fake.emitStdout('world')
    fake.exit({ code: 0 })

    const stored = runs.get(record.runId)
    expect(stored?.status).toBe('succeeded')
    expect(stored?.exitCode).toBe(0)
    expect(stored?.output).toBe('hello world')
    expect(stored?.endedAt).not.toBeNull()
    expect(stored?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it.each<[string, Partial<ExitInfo>, RunStatus]>([
    ['a non-zero exit', { code: 1 }, 'failed'],
    ['a timeout kill', { code: null, reason: 'timeout' }, 'timeout'],
    ['a cancellation', { code: null, reason: 'cancelled' }, 'cancelled'],
    ['a spawn failure', { code: null, reason: 'spawn-error', error: 'ENOENT' }, 'failed']
  ])('maps %s to status %s', async (_label, info, expected) => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'cli' })
    fake.exit(info)
    expect(runs.get(record.runId)?.status).toBe(expected)
  })

  it('keeps the spawn error message on the record', async () => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'cli' })
    fake.exit({ code: null, reason: 'spawn-error', error: 'claude not found' })
    expect(runs.get(record.runId)?.error).toBe('claude not found')
  })

  it('caps retained output at the configured size', async () => {
    h.config.outputCapBytes = 10
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'cli' })

    fake.emitStdout('0123456789ABCDE')
    fake.exit({ code: 0 })

    expect(runs.get(record.runId)?.output).toBe('56789ABCDE')
  })

  it('emits started, chunk and completed on the bus', async () => {
    await setup()
    const events: string[] = []
    bus.on('skill:run:started', () => events.push('started'))
    bus.on('skill:run:chunk', (e) => events.push(`chunk:${e.stream}`))
    bus.on('skill:run:completed', (e) => events.push(`completed:${e.status}`))

    await executor.run({ skillId: 'news-digest', trigger: 'cli' })
    fake.emitStdout('x')
    fake.exit({ code: 0 })

    expect(events).toEqual(['started', 'chunk:stdout', 'completed:succeeded'])
  })

  it('does not spawn on a dry run, but still records the command', async () => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'cli', dryRun: true })

    expect(fake.calls).toHaveLength(0)
    const stored = runs.get(record.runId)
    expect(stored?.status).toBe('succeeded')
    expect(stored?.output).toContain('[dry-run] claude -p')
  })
})

describe('SkillExecutor.cancel', () => {
  it('kills a live run and settles it as cancelled', async () => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'cli' })

    expect(executor.cancel(record.runId)).toBe(true)
    expect(fake.cancelled).toBe(1)
    expect(runs.get(record.runId)?.status).toBe('cancelled')
  })

  it('returns false for a run that already finished', async () => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'cli' })
    fake.exit({ code: 0 })
    expect(executor.cancel(record.runId)).toBe(false)
  })
})

describe('routine wiring', () => {
  it('executes the skill named by a routine:fired event', async () => {
    await setup()
    executor.start()

    bus.emit('routine:fired', { routineId: 'r1', skillId: 'news-digest', args: 'daily', attempt: 1 })
    await new Promise((resolve) => setImmediate(resolve))

    expect(fake.calls[0]?.args[1]).toBe('/news-digest daily')
    expect(executor.history()[0]).toMatchObject({ trigger: 'routine', routineId: 'r1' })
  })

  it('does not subscribe twice when start is called again', async () => {
    await setup()
    executor.start()
    executor.start()

    bus.emit('routine:fired', { routineId: 'r1', skillId: 'news-digest', attempt: 1 })
    await new Promise((resolve) => setImmediate(resolve))

    expect(fake.calls).toHaveLength(1)
  })

  it('swallows a routine pointing at a skill that no longer exists', async () => {
    await setup()
    executor.start()

    bus.emit('routine:fired', { routineId: 'r1', skillId: 'deleted-skill', attempt: 1 })
    await new Promise((resolve) => setImmediate(resolve))

    expect(fake.calls).toHaveLength(0)
  })
})

describe('startup reconciliation', () => {
  it('marks runs the previous session left running as interrupted', async () => {
    await setup()
    const record = await executor.run({ skillId: 'news-digest', trigger: 'dashboard' })

    expect(executor.reconcile()).toBe(1)
    const stored = runs.get(record.runId)
    expect(stored?.status).toBe('interrupted')
    expect(stored?.endedAt).not.toBeNull()
    expect(stored?.error).toMatch(/restart/)
  })

  it('leaves finished runs alone', async () => {
    await setup()
    await executor.run({ skillId: 'news-digest', trigger: 'cli', dryRun: true })
    expect(executor.reconcile()).toBe(0)
  })
})

describe('SkillExecutor.history', () => {
  it('filters by skill and honours the limit', async () => {
    h.writeSkill('workspace', 'a', skillDoc({ name: 'a' }))
    h.writeSkill('workspace', 'b', skillDoc({ name: 'b' }))
    await registry.refresh()

    await executor.run({ skillId: 'a', trigger: 'cli', dryRun: true })
    await executor.run({ skillId: 'b', trigger: 'cli', dryRun: true })

    expect(executor.history({ skillId: 'a' }).map((r) => r.skillId)).toEqual(['a'])
    expect(executor.history({ limit: 1 })).toHaveLength(1)
  })
})
