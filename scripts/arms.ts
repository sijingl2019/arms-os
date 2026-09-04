#!/usr/bin/env tsx
/**
 * Verification CLI for the Skill Registry & Executor. Exists so the module can
 * be exercised end to end before the Electron shell is built - it is not the
 * product surface.
 */
import process from 'node:process'
import type {
  AgentId,
  MissedRunPolicy,
  RoutineDef,
  RoutineInput,
  RunRecord,
  SkillMeta
} from '@shared/types'
import { createCore, type ArmsCore } from '@main/core'
import { planSystemTask } from '@main/routines/systemTask'
import { writeSkillsIndex } from '@main/skills/indexFile'

const USAGE = `arms - ARMS Agentic OS skill tooling

  arms skills refresh                   rescan the skill roots and update the index
  arms skills list [--source S]         list indexed skills
  arms skills show <id>                 show one skill, guardrails included
  arms skills match <text>              resolve free text to skills via triggers
  arms skills index [dest]              write SKILLS_INDEX.md
  arms run <id> [options]               execute a skill headless
  arms runs [--skill <id>] [--routine <id>] [--limit N]
                                        recent run records
  arms doctor                           show resolved config and scan roots

  arms gateway status                   connectors, tools and their risk tiers
  arms gateway serve                    run the MCP endpoint until Ctrl+C
  arms gateway calls [--limit N]        recent tool calls from the audit table
  arms gateway pending                  approvals waiting on a human
  arms gateway approve <id>
  arms gateway reject <id> [--reason R]

  arms routines list                    list routines with their next run time
  arms routines add --name N --skill S --cron "0 9 * * *" [routine options]
  arms routines set <id> [routine options]
  arms routines rm <id>
  arms routines tick [--at <iso>]       run one scheduler pass by hand
  arms routines export <id>             print an OS-level scheduled task command

routine options:
  --name, --skill, --cron, --tz, --args, --agent, --model, --effort
  --enabled true|false
  --missed skip|catch-up-once           what to do about a trigger missed offline
  --retries N  --retry-delay <ms>

run options:
  --args "<text>"   appended to the prompt
  --agent claude|codex
  --model <id>      overrides the skill's model_hint
  --effort <level>  overrides the skill's effort_hint
  --cwd <dir>       defaults to the workspace root
  --timeout <ms>
  --dry-run         record the command line without spawning anything

global:
  --workspace <dir>  overrides ARMS_WORKSPACE
`

interface Flags {
  positional: string[]
  options: Record<string, string | boolean>
}

function parseArgv(argv: string[]): Flags {
  const positional: string[] = []
  const options: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      i += 1
    }
  }

  return { positional, options }
}

const str = (flags: Flags, key: string): string | undefined => {
  const value = flags.options[key]
  return typeof value === 'string' ? value : undefined
}

function printSkill(skill: SkillMeta): void {
  const g = skill.guardrails
  console.log(`${skill.id}  [${skill.source}]`)
  console.log(`  ${skill.description || '(no description)'}`)
  console.log(`  path      ${skill.path}`)
  console.log(`  triggers  ${skill.triggers.join(', ') || '-'}`)
  console.log(`  hints     model=${skill.modelHint ?? '-'} effort=${skill.effortHint ?? '-'}`)
  const split = skill.lines > 150 ? '  (past 150 lines - consider a Skill Tree split)' : ''
  console.log(`  lines     ${skill.lines}${split}`)

  const section = (title: string, items: string[]): void => {
    console.log(`  ${title}`)
    if (items.length === 0) console.log('    (none declared)')
    for (const item of items) console.log(`    - ${item}`)
  }
  section('绝对不能做的事', g.forbidden)
  section('需要人工确认的动作', g.confirmRequired)
  section('依赖的 Application', g.connectors)
}

function printRuns(records: RunRecord[]): void {
  if (records.length === 0) {
    console.log('(no runs yet)')
    return
  }
  for (const r of records) {
    const seconds = r.durationMs === null ? '-' : `${Math.round(r.durationMs / 1000)}s`
    console.log(
      `${r.startedAt}  ${r.status.padEnd(11)} ${(r.skillId ?? '(raw)').padEnd(24)} ` +
        `via=${r.trigger.padEnd(9)} exit=${String(r.exitCode ?? '-').padEnd(4)} ${seconds}`
    )
  }
}

async function skillsCommand(core: ArmsCore, flags: Flags): Promise<number> {
  const [, sub = 'list', ...rest] = flags.positional

  if (sub === 'refresh') {
    const result = await core.registry.refresh()
    console.log(
      `added=${result.added} updated=${result.updated} ` +
        `removed=${result.removed} unchanged=${result.unchanged}`
    )
    for (const warning of result.warnings) console.warn(`warn: ${warning}`)
    return 0
  }

  if (sub === 'list') {
    const source = str(flags, 'source')
    const skills = core.registry.list().filter((s) => !source || s.source === source)
    if (skills.length === 0) {
      console.log('(no skills indexed - run `arms skills refresh` first)')
      return 0
    }
    for (const skill of skills) {
      const risky = skill.guardrails.confirmRequired.length > 0 ? '  [high-risk]' : ''
      console.log(`${skill.id.padEnd(28)} [${skill.source}] ${skill.description}${risky}`)
    }
    return 0
  }

  if (sub === 'show') {
    const id = rest[0]
    if (!id) {
      console.error('usage: arms skills show <id>')
      return 2
    }
    const skill = core.registry.get(id)
    if (!skill) {
      console.error(`unknown skill: ${id}`)
      return 1
    }
    printSkill(skill)
    return 0
  }

  if (sub === 'match') {
    const text = rest.join(' ')
    const matches = core.registry.findByTrigger(text)
    if (matches.length === 0) {
      console.log(`(no skill matches ${JSON.stringify(text)})`)
      return 1
    }
    for (const skill of matches) console.log(`${skill.id}  ${skill.description}`)
    return 0
  }

  if (sub === 'index') {
    const dest = rest[0] ?? core.config.skillsIndexPath
    await writeSkillsIndex(dest, core.registry.list())
    console.log(`wrote ${dest}`)
    return 0
  }

  console.error(`unknown subcommand: skills ${sub}`)
  return 2
}

async function runCommand(core: ArmsCore, flags: Flags): Promise<number> {
  const id = flags.positional[1]
  if (!id) {
    console.error('usage: arms run <id> [options]')
    return 2
  }

  const args = str(flags, 'args')
  const agent = str(flags, 'agent')
  const model = str(flags, 'model')
  const effort = str(flags, 'effort')
  const cwd = str(flags, 'cwd')
  const timeout = str(flags, 'timeout')
  const dryRun = flags.options['dry-run'] === true

  const record = await core.executor.run({
    skillId: id,
    trigger: 'cli',
    ...(args === undefined ? {} : { args }),
    ...(agent === undefined ? {} : { agent: agent as AgentId }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
    ...(dryRun ? { dryRun: true } : {})
  })

  console.log(`run ${record.runId}`)
  console.log(`  ${record.command}`)

  if (dryRun) {
    console.log('  (dry run - nothing was spawned)')
    return 0
  }

  // Stream to the terminal, then resolve when this run reports completion.
  const stopChunks = core.bus.on('skill:run:chunk', (event) => {
    if (event.runId !== record.runId) return
    const target = event.stream === 'stderr' ? process.stderr : process.stdout
    target.write(event.chunk)
  })

  const status = await new Promise<string>((resolve) => {
    const stopEnd = core.bus.on('skill:run:completed', (event) => {
      if (event.runId !== record.runId) return
      stopEnd()
      resolve(event.status)
    })
  })

  stopChunks()
  console.log(`\n[${status}]`)
  return status === 'succeeded' ? 0 : 1
}

function routineOptions(flags: Flags): Partial<RoutineInput> {
  const bool = (key: string): boolean | undefined => {
    const raw = flags.options[key]
    if (raw === undefined) return undefined
    return raw === true || raw === 'true'
  }
  const num = (key: string): number | undefined => {
    const raw = str(flags, key)
    return raw === undefined ? undefined : Number(raw)
  }

  const patch: Partial<RoutineInput> = {}
  const name = str(flags, 'name')
  const skillId = str(flags, 'skill')
  const cron = str(flags, 'cron')
  const tz = str(flags, 'tz')
  const args = str(flags, 'args')
  const agent = str(flags, 'agent')
  const model = str(flags, 'model')
  const effort = str(flags, 'effort')
  const missed = str(flags, 'missed')
  const enabled = bool('enabled')
  const retries = num('retries')
  const retryDelay = num('retry-delay')

  if (name !== undefined) patch.name = name
  if (skillId !== undefined) patch.skillId = skillId
  if (cron !== undefined) patch.cron = cron
  if (tz !== undefined) patch.timezone = tz
  if (args !== undefined) patch.args = args
  if (agent !== undefined) patch.agent = agent as AgentId
  if (model !== undefined) patch.model = model
  if (effort !== undefined) patch.effort = effort
  if (missed !== undefined) patch.missedRunPolicy = missed as MissedRunPolicy
  if (enabled !== undefined) patch.enabled = enabled
  if (retries !== undefined) patch.maxRetries = retries
  if (retryDelay !== undefined) patch.retryDelayMs = retryDelay
  return patch
}

function printRoutine(r: RoutineDef): void {
  const state = r.enabled ? 'on ' : 'off'
  console.log(
    `${state} ${r.id.slice(0, 8)}  ${r.name.padEnd(24)} ${r.skillId.padEnd(20)} ` +
      `${r.cron.padEnd(14)} next=${r.nextRunAt ?? '-'} last=${r.lastStatus ?? '-'}`
  )
}

async function routinesCommand(core: ArmsCore, flags: Flags): Promise<number> {
  const [, sub = 'list', ...rest] = flags.positional

  /** Accept an id prefix, the way git accepts a short sha. */
  const resolve = (prefix: string): RoutineDef | undefined => {
    const all = core.routines.list()
    return all.find((r) => r.id === prefix) ?? all.find((r) => r.id.startsWith(prefix))
  }

  if (sub === 'list') {
    const all = core.routines.list()
    if (all.length === 0) {
      console.log('(no routines - add one with `arms routines add`)')
      return 0
    }
    all.forEach(printRoutine)
    return 0
  }

  if (sub === 'add') {
    const patch = routineOptions(flags)
    if (!patch.name || !patch.skillId || !patch.cron) {
      console.error('usage: arms routines add --name N --skill S --cron "0 9 * * *"')
      return 2
    }
    if (!core.registry.get(patch.skillId)) {
      console.error(`unknown skill: ${patch.skillId} (run \`arms skills refresh\` first)`)
      return 1
    }
    const created = core.routines.create(patch as RoutineInput)
    printRoutine(created)
    return 0
  }

  if (sub === 'set' || sub === 'rm') {
    const prefix = rest[0]
    if (!prefix) {
      console.error(`usage: arms routines ${sub} <id>`)
      return 2
    }
    const found = resolve(prefix)
    if (!found) {
      console.error(`unknown routine: ${prefix}`)
      return 1
    }
    if (sub === 'rm') {
      core.routines.remove(found.id)
      console.log(`removed ${found.id}  ${found.name}`)
      return 0
    }
    printRoutine(core.routines.update(found.id, routineOptions(flags)))
    return 0
  }

  if (sub === 'tick') {
    const at = str(flags, 'at')
    const now = at === undefined ? new Date() : new Date(at)
    if (Number.isNaN(now.getTime())) {
      console.error(`not a date: ${at}`)
      return 2
    }
    if (flags.options['dry-run'] === true) {
      // Unsubscribe the executor so a tick can be inspected without an agent
      // process actually being launched.
      core.executor.stop()
      console.log('(dry run - executor detached, nothing will be spawned)')
    }

    const result = core.scheduler.tick(now)
    console.log(
      `fired=${result.fired.length} retried=${result.retried.length} skipped=${result.skipped.length}`
    )
    for (const id of result.fired) {
      const r = core.routines.get(id)
      console.log(`  fired   ${id.slice(0, 8)} ${r?.name ?? ''}  next=${r?.nextRunAt ?? '-'}`)
    }
    for (const s of result.skipped) console.log(`  skipped ${s.routineId.slice(0, 8)}: ${s.reason}`)
    return 0
  }

  if (sub === 'export') {
    const prefix = rest[0]
    const found = prefix ? resolve(prefix) : undefined
    if (!found) {
      console.error('usage: arms routines export <id>')
      return 2
    }
    const plan = planSystemTask({ routine: found, workspaceRoot: core.config.workspaceRoot })
    if (!plan.command) {
      console.error(`cannot express this routine as a ${plan.platform} scheduled task:`)
      for (const note of plan.notes) console.error(`  - ${note}`)
      return 1
    }
    console.log(`# ${plan.platform} scheduled task for "${found.name}"`)
    for (const note of plan.notes) console.log(`# note: ${note}`)
    console.log(plan.command)
    return 0
  }

  console.error(`unknown subcommand: routines ${sub}`)
  return 2
}

async function gatewayCommand(core: ArmsCore, flags: Flags): Promise<number> {
  const [, sub = 'status', ...rest] = flags.positional

  if (sub === 'status' || sub === 'serve') {
    const started = await core.startGateway()
    const status = core.gatewayStatus()

    console.log(`endpoint   ${started.endpoint}`)
    console.log(`manifest   ${status.manifestPath}`)
    console.log(`vault      ${status.vault.kind} (available=${status.vault.available})`)
    if (started.expired > 0) {
      console.log(`expired    ${started.expired} approval(s) left pending by a previous session`)
    }
    for (const issue of status.issues) console.warn(`warn: ${issue}`)

    if (status.tools.length === 0) {
      console.log('\n(no connector tools - is connectors/manifest.yaml present?)')
    } else {
      console.log('\ntools')
      for (const tool of status.tools) {
        console.log(`  ${tool.qualifiedName.padEnd(32)} [${tool.risk}] ${tool.description}`)
      }
    }

    if (sub !== 'serve') return 0

    console.log('\nattach an agent with:')
    console.log(`  claude mcp add --transport http arms-gateway ${started.endpoint}`)
    console.log(`  codex  mcp add arms-gateway --url ${started.endpoint}`)
    console.log('\nlistening - Ctrl+C to stop')
    // Approvals need a human, and there is no dashboard here, so say so loudly.
    core.bus.on('gateway:confirmation:pending', (item) => {
      console.log(`\n[approval needed] ${item.qualifiedName} ${JSON.stringify(item.args)}`)
      console.log(`  arms gateway approve ${item.confirmationId}`)
      console.log(`  arms gateway reject  ${item.confirmationId}`)
    })
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()))
    return 0
  }

  if (sub === 'calls') {
    const limit = Number(str(flags, 'limit') ?? 30)
    const rows = core.db
      .prepare('SELECT * FROM tool_calls ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, string | number | null>>
    if (rows.length === 0) {
      console.log('(no tool calls recorded)')
      return 0
    }
    for (const r of rows) {
      console.log(
        `${String(r['started_at'])}  ${String(r['outcome']).padEnd(10)} ` +
          `${String(r['qualified_name']).padEnd(30)} [${String(r['risk'])}] ${r['error'] ?? ''}`
      )
    }
    return 0
  }

  if (sub === 'pending') {
    const items = core.gateway.confirmations.listPending()
    if (items.length === 0) {
      console.log('(nothing awaiting approval)')
      return 0
    }
    for (const item of items) {
      console.log(`${item.confirmationId}  ${item.qualifiedName}  [${item.risk}]`)
      console.log(`  args    ${JSON.stringify(item.args)}`)
      console.log(`  expires ${item.expiresAt}`)
    }
    return 0
  }

  if (sub === 'approve' || sub === 'reject') {
    const id = rest[0]
    if (!id) {
      console.error(`usage: arms gateway ${sub} <confirmation-id>`)
      return 2
    }
    const ok =
      sub === 'approve'
        ? core.gateway.confirmations.approve(id)
        : core.gateway.confirmations.reject(id, str(flags, 'reason') ?? 'rejected from the CLI')
    if (!ok) {
      // A separate CLI process cannot answer a request the app is blocking on:
      // the waiting promise lives in that other process.
      console.error(
        `no pending approval with id ${id} in this process ` +
          '(an approval is answered by whichever process is blocking on it)'
      )
      return 1
    }
    console.log(`${sub}d ${id}`)
    return 0
  }

  console.error(`unknown subcommand: gateway ${sub}`)
  return 2
}

function doctorCommand(core: ArmsCore): number {
  const { config } = core
  console.log(`workspace     ${config.workspaceRoot}`)
  console.log(`state dir     ${config.stateDir}`)
  console.log(`database      ${config.dbPath}`)
  console.log(`run log       ${config.runLogPath}`)
  console.log(`skills index  ${config.skillsIndexPath}`)
  console.log(`agent         ${config.defaultAgent}, timeout ${config.defaultTimeoutMs}ms`)
  console.log('scan roots')
  for (const root of config.scanRoots) console.log(`  [${root.source}] ${root.dir}`)
  console.log(`indexed       ${core.registry.list().length} skills`)
  const routines = core.routines.list()
  const on = routines.filter((r) => r.enabled).length
  console.log(`routines      ${routines.length} (${on} enabled)`)
  const soonest = routines
    .map((r) => r.nextRunAt)
    .filter((v): v is string => v !== null)
    .sort()[0]
  if (soonest) console.log(`next trigger  ${soonest}`)
  if (core.interrupted > 0) {
    console.log(`reconciled    ${core.interrupted} run(s) left running by a previous session`)
  }
  return 0
}

async function main(): Promise<number> {
  const flags = parseArgv(process.argv.slice(2))
  const command = flags.positional[0]

  if (!command || command === 'help' || flags.options['help'] === true) {
    console.log(USAGE)
    return command ? 0 : 2
  }

  const workspace = str(flags, 'workspace')
  const core = createCore(workspace === undefined ? {} : { workspaceRoot: workspace })

  try {
    switch (command) {
      case 'skills':
        return await skillsCommand(core, flags)
      case 'run':
        return await runCommand(core, flags)
      case 'gateway':
        return await gatewayCommand(core, flags)
      case 'routines':
        return await routinesCommand(core, flags)
      case 'runs': {
        const skillId = str(flags, 'skill')
        const routineId = str(flags, 'routine')
        const limit = str(flags, 'limit')
        printRuns(
          core.executor.history({
            ...(skillId === undefined ? {} : { skillId }),
            ...(routineId === undefined ? {} : { routineId }),
            ...(limit === undefined ? {} : { limit: Number(limit) })
          })
        )
        return 0
      }
      case 'doctor':
        return doctorCommand(core)
      default:
        console.error(`unknown command: ${command}\n`)
        console.log(USAGE)
        return 2
    }
  } finally {
    await core.close()
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    console.error(`error: ${(err as Error).message}`)
    process.exitCode = 1
  }
)
