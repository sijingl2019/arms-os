import path from 'node:path'
import { Cron } from 'croner'
import type { RoutineDef } from '@shared/types'

/**
 * Routine L2 (架构规范 §6.1): hand the schedule to the operating system so it
 * fires even when this app is not running.
 *
 * We only ever *generate* the command and print it - registering an OS-level
 * scheduled task behind the user's back is exactly the kind of side effect the
 * guardrail rules exist to prevent. The user runs it themselves.
 *
 * The generated task re-enters this app's CLI rather than calling the agent
 * directly, so the run still lands in the `runs` table and runs.log.
 */

export type SystemTaskPlatform = 'win32' | 'darwin' | 'linux'

export interface SystemTaskOptions {
  routine: RoutineDef
  /** Absolute path to the workspace, passed through to `arms run`. */
  workspaceRoot: string
  platform?: SystemTaskPlatform
  /** Command that invokes this CLI, e.g. `npx tsx scripts/arms.ts`. */
  cliCommand?: string
}

export interface SystemTaskPlan {
  platform: SystemTaskPlatform
  /** What the user should run (or, for launchd, write to a file). */
  command: string
  /** Extra context worth printing alongside the command. */
  notes: string[]
}

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const

function quoteWin(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The `arms run` invocation the OS task should execute. */
function innerCommand(o: Required<Pick<SystemTaskOptions, 'cliCommand' | 'workspaceRoot'>> & {
  routine: RoutineDef
}): string {
  const target = o.routine.target
  if (target.kind === 'tool') {
    return [
      o.cliCommand,
      'gateway',
      'call',
      target.toolName,
      '--workspace',
      o.workspaceRoot,
      '--args',
      JSON.stringify(target.toolArgs)
    ].join(' ')
  }

  const parts = [o.cliCommand, 'run', target.skillId, '--workspace', o.workspaceRoot]
  if (target.args) parts.push('--args', target.args)
  if (target.agent) parts.push('--agent', target.agent)
  if (target.model) parts.push('--model', target.model)
  if (target.effort) parts.push('--effort', target.effort)
  return parts.join(' ')
}

/**
 * schtasks cannot take a cron expression, so we read the next occurrence out of
 * croner and translate the common daily/weekly shapes. Anything more exotic
 * (multiple times a day, step values on hours) has no schtasks equivalent and
 * is reported instead of silently mistranslated.
 */
function windowsSchedule(routine: RoutineDef): { flags: string[]; notes: string[] } {
  const notes: string[] = []
  const fields = routine.cron.trim().split(/\s+/)
  const [minute, hour, dom, , dow] = fields

  if (fields.length < 5 || minute === undefined || hour === undefined) {
    return { flags: [], notes: ['cron expression is not in the 5-field form schtasks can express'] }
  }
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) {
    return {
      flags: [],
      notes: [
        `schtasks cannot express "${routine.cron}" - it only understands a single daily or weekly time`
      ]
    }
  }

  const at = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
  const everyDom = dom === '*' || dom === undefined
  const everyDow = dow === '*' || dow === undefined

  if (everyDow && everyDom) return { flags: ['/SC', 'DAILY', '/ST', at], notes }

  if (!everyDow && /^[0-6](,[0-6])*$/.test(dow)) {
    const days = dow.split(',').map((d) => DOW[Number(d)]).join(',')
    return { flags: ['/SC', 'WEEKLY', '/D', days, '/ST', at], notes }
  }

  return {
    flags: [],
    notes: [`schtasks cannot express the day fields of "${routine.cron}"`]
  }
}

export function planSystemTask({
  routine,
  workspaceRoot,
  platform = process.platform as SystemTaskPlatform,
  cliCommand = 'npx tsx scripts/arms.ts'
}: SystemTaskOptions): SystemTaskPlan {
  const inner = innerCommand({ routine, workspaceRoot, cliCommand })
  const notes: string[] = []

  if (routine.timezone) {
    notes.push(
      `the routine is scheduled in ${routine.timezone}; an OS task uses the machine's local time`
    )
  }
  notes.push('this bypasses the in-app scheduler, so disable the routine in ARMS to avoid double runs')

  if (platform === 'win32') {
    const { flags, notes: scheduleNotes } = windowsSchedule(routine)
    if (flags.length === 0) {
      return { platform, command: '', notes: [...scheduleNotes, ...notes] }
    }
    const command = [
      'schtasks /Create',
      `/TN ${quoteWin(`ARMS - ${routine.name}`)}`,
      flags.join(' '),
      `/TR ${quoteWin(`cmd /c cd /d ${workspaceRoot} && ${inner}`)}`
    ].join(' ')
    return { platform, command, notes: [...scheduleNotes, ...notes] }
  }

  if (platform === 'linux') {
    const command = `( crontab -l 2>/dev/null; echo ${shellQuote(
      `${routine.cron} cd ${workspaceRoot} && ${inner}  # ARMS ${routine.id}`
    )} ) | crontab -`
    return { platform, command, notes }
  }

  // darwin: launchd wants a plist, and cron's day-of-week ordering differs, so
  // emit the calendar interval derived from croner rather than the raw string.
  const next = new Cron(routine.cron, routine.timezone ? { timezone: routine.timezone } : undefined)
    .nextRun()
  const label = `com.arms-os.${routine.id}`
  const plistPath = path.posix.join('~/Library/LaunchAgents', `${label}.plist`)
  notes.push(
    next
      ? `next occurrence is ${next.toISOString()}; adjust StartCalendarInterval if the cron is more complex`
      : 'this cron has no future occurrence'
  )
  const command = [
    `cat > ${plistPath} <<'PLIST'`,
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    `  <array><string>/bin/sh</string><string>-c</string><string>cd ${workspaceRoot} &amp;&amp; ${inner}</string></array>`,
    '  <key>StartCalendarInterval</key>',
    `  <dict>${calendarInterval(routine.cron)}</dict>`,
    '</dict></plist>',
    'PLIST',
    `launchctl load ${plistPath}`
  ].join('\n')

  return { platform, command, notes }
}

/** Best-effort translation of the numeric cron fields launchd understands. */
function calendarInterval(cron: string): string {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/)
  const pairs: string[] = []
  const add = (key: string, value: string | undefined): void => {
    if (value !== undefined && /^\d+$/.test(value)) {
      pairs.push(`<key>${key}</key><integer>${Number(value)}</integer>`)
    }
  }
  add('Minute', minute)
  add('Hour', hour)
  add('Day', dom)
  add('Month', month)
  add('Weekday', dow)
  return pairs.join('')
}
