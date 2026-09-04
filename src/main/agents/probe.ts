import { execFile } from 'node:child_process'
import type { AgentInfo } from '@shared/types'
import { listRuntimes } from './registry'

/**
 * Is each agent CLI actually installed?
 *
 * The Settings panel needs this: a default agent that is not on PATH turns
 * every run and every routine into a spawn error, and that is much easier to
 * understand here than in a failed run's stderr.
 */

/** `--version` on a CLI should be instant; anything slower is a hang. */
const TIMEOUT_MS = 4_000

/** Both CLIs answer `--version`; kept in one place so a third one is obvious. */
const VERSION_ARGS = ['--version']

/** Shown in the UI. The runtimes themselves deal in ids, not labels. */
const LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI'
}

function version(command: string): Promise<{ version: string } | { reason: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      VERSION_ARGS,
      { timeout: TIMEOUT_MS, windowsHide: true, shell: process.platform === 'win32' },
      (err, stdout) => {
        if (err) {
          const message = err.message.split('\n')[0] ?? 'not available'
          resolve({ reason: /ENOENT|not recognized|not found/i.test(message) ? '不在 PATH 上' : message })
          return
        }
        resolve({ version: stdout.trim().split('\n')[0] ?? '' })
      }
    )
  })
}

export async function probeAgents(defaultAgent: string): Promise<AgentInfo[]> {
  return Promise.all(
    listRuntimes().map(async (runtime) => {
      const probed = await version(runtime.command)
      return {
        id: runtime.id,
        label: LABELS[runtime.id] ?? runtime.id,
        command: runtime.command,
        isDefault: runtime.id === defaultAgent,
        ...('version' in probed
          ? { available: true, version: probed.version, reason: null }
          : { available: false, version: null, reason: probed.reason })
      }
    })
  )
}
