import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { ExitInfo, ProcessHandle, SpawnCallbacks, SpawnRequest, Spawner } from './types'

const IS_WINDOWS = process.platform === 'win32'
/** Grace period between SIGTERM and SIGKILL on POSIX. */
const KILL_GRACE_MS = 3000

/**
 * MSVCRT-style quoting. Needed because agent CLIs ship as `.cmd` shims on
 * Windows, which Node can only launch through a shell - and with `shell: true`
 * Node passes the argv through verbatim instead of quoting it for us.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"^&|<>()%!,;=]/.test(arg)) return arg
  // Double every backslash run that precedes a quote (or ends the argument),
  // then escape the quote itself - MSVCRT's rule for reversing this on the
  // other side.
  const escaped = arg
    .replace(/(\\*)"/g, String.raw`$1$1\"`)
    .replace(/(\\*)$/, '$1$1')
  return `"${escaped}"`
}

/**
 * Kill the whole tree. On Windows the direct child is `cmd.exe`, so killing it
 * alone would orphan the agent process; `taskkill /T` is the only reliable way
 * down. On POSIX the child leads its own process group, so one signal to the
 * negated pid reaches everything it spawned.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return

  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, KILL_GRACE_MS).unref()
}

/**
 * Spawn an agent CLI, stream its output, and guarantee exactly one `onExit`.
 * A run that produces nothing and never exits is killed at `timeoutMs`
 * (系统设计文档 §9).
 */
export const nodeSpawner: Spawner = (req: SpawnRequest, cb: SpawnCallbacks): ProcessHandle => {
  const command = IS_WINDOWS ? quoteWindowsArg(req.command) : req.command
  const args = IS_WINDOWS ? req.args.map(quoteWindowsArg) : req.args

  let settled = false
  let reason: ExitInfo['reason'] = 'exit'
  let timer: NodeJS.Timeout | undefined

  const finish = (info: ExitInfo): void => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    cb.onExit(info)
  }

  let child: ChildProcess
  try {
    child = spawn(command, args, {
      cwd: req.cwd,
      shell: IS_WINDOWS,
      // Own process group on POSIX so killTree can reach grandchildren.
      detached: !IS_WINDOWS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    finish({ code: null, signal: null, reason: 'spawn-error', error: (err as Error).message })
    return { cancel: () => {} }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => cb.onStdout(chunk))
  child.stderr?.on('data', (chunk: string) => cb.onStderr(chunk))

  child.on('error', (err) => {
    finish({ code: null, signal: null, reason: 'spawn-error', error: err.message })
  })
  child.on('close', (code, signal) => {
    finish({ code, signal, reason })
  })

  if (req.timeoutMs > 0) {
    timer = setTimeout(() => {
      reason = 'timeout'
      killTree(child)
    }, req.timeoutMs)
    timer.unref()
  }

  return {
    cancel: () => {
      if (settled) return
      reason = 'cancelled'
      killTree(child)
    }
  }
}
