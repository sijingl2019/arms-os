#!/usr/bin/env tsx
/**
 * Verification CLI for the Skill Registry & Executor. Exists so the module can
 * be exercised end to end before the Electron shell is built - it is not the
 * product surface.
 */
import process from 'node:process'
import type { AgentId, RunRecord, SkillMeta } from '@shared/types'
import { createCore, type ArmsCore } from '@main/core'
import { writeSkillsIndex } from '@main/skills/indexFile'

const USAGE = `arms - ARMS Agentic OS skill tooling

  arms skills refresh                   rescan the skill roots and update the index
  arms skills list [--source S]         list indexed skills
  arms skills show <id>                 show one skill, guardrails included
  arms skills match <text>              resolve free text to skills via triggers
  arms skills index [dest]              write SKILLS_INDEX.md
  arms run <id> [options]               execute a skill headless
  arms runs [--skill <id>] [--limit N]  recent run records
  arms doctor                           show resolved config and scan roots

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
      case 'runs': {
        const skillId = str(flags, 'skill')
        const limit = str(flags, 'limit')
        printRuns(
          core.executor.history({
            ...(skillId === undefined ? {} : { skillId }),
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
    core.close()
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
