import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { nodeSpawner } from '@main/agents/spawn'
import type { ExitInfo, SpawnRequest } from '@main/agents/types'

/**
 * Exercises the real spawner against real `node` child processes. The fake
 * spawner in executor.test.ts covers the state machine; this covers the parts
 * only the OS can tell us about - argument quoting through cmd.exe, stream
 * decoding, timeout kills, and cancellation.
 */

interface Outcome {
  stdout: string
  stderr: string
  exit: ExitInfo
}

function runNode(
  script: string,
  { timeoutMs = 15_000, cancelAfterMs }: { timeoutMs?: number; cancelAfterMs?: number } = {}
): Promise<Outcome> {
  const req: SpawnRequest = {
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    timeoutMs
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const handle = nodeSpawner(req, {
      onStdout: (chunk) => {
        stdout += chunk
      },
      onStderr: (chunk) => {
        stderr += chunk
      },
      onExit: (exit) => resolve({ stdout, stderr, exit })
    })

    if (cancelAfterMs !== undefined) setTimeout(() => handle.cancel(), cancelAfterMs)
  })
}

describe('nodeSpawner', () => {
  it('captures stdout and a zero exit code', async () => {
    const { stdout, exit } = await runNode('process.stdout.write("hello")')
    expect(stdout).toBe('hello')
    expect(exit).toMatchObject({ code: 0, reason: 'exit' })
  })

  it('captures stderr separately and reports a non-zero exit code', async () => {
    const { stdout, stderr, exit } = await runNode(
      'process.stderr.write("boom"); process.exit(3)'
    )
    expect(stdout).toBe('')
    expect(stderr).toBe('boom')
    expect(exit).toMatchObject({ code: 3, reason: 'exit' })
  })

  it('passes an argument containing spaces and quotes through intact', async () => {
    // The prompt an agent CLI receives is exactly this shape, and on Windows it
    // has to survive a trip through cmd.exe.
    const script = 'process.stdout.write(process.argv[1])'
    const payload = '/news-digest "today" & tomorrow'
    const outcome = await new Promise<Outcome>((resolve) => {
      let stdout = ''
      nodeSpawner(
        {
          command: process.execPath,
          args: ['-e', script, payload],
          cwd: process.cwd(),
          timeoutMs: 15_000
        },
        {
          onStdout: (chunk) => {
            stdout += chunk
          },
          onStderr: () => {},
          onExit: (exit) => resolve({ stdout, stderr: '', exit })
        }
      )
    })

    expect(outcome.stdout).toBe(payload)
    expect(outcome.exit.code).toBe(0)
  })

  it('kills a process that outlives its timeout', async () => {
    const { exit } = await runNode('setInterval(() => {}, 1000)', { timeoutMs: 700 })
    expect(exit.reason).toBe('timeout')
    expect(exit.code).not.toBe(0)
  }, 20_000)

  it('kills a process on cancel', async () => {
    const { exit } = await runNode('setInterval(() => {}, 1000)', {
      timeoutMs: 15_000,
      cancelAfterMs: 300
    })
    expect(exit.reason).toBe('cancelled')
  }, 20_000)

  it('reports a missing executable instead of throwing', async () => {
    const { exit } = await new Promise<Outcome>((resolve) => {
      let stderr = ''
      nodeSpawner(
        {
          command: 'arms-no-such-binary-xyz',
          args: [],
          cwd: process.cwd(),
          timeoutMs: 5000
        },
        {
          onStdout: () => {},
          onStderr: (chunk) => {
            stderr += chunk
          },
          onExit: (info) => resolve({ stdout: '', stderr, exit: info })
        }
      )
    })

    // POSIX surfaces this as a spawn error; cmd.exe swallows it and exits 1.
    expect(['spawn-error', 'exit']).toContain(exit.reason)
    expect(exit.code).not.toBe(0)
  }, 20_000)

  it('calls onExit exactly once even when cancelled after it already exited', async () => {
    let calls = 0
    const handle = nodeSpawner(
      {
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        timeoutMs: 15_000
      },
      {
        onStdout: () => {},
        onStderr: () => {},
        onExit: () => {
          calls += 1
        }
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 1500))
    handle.cancel()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(calls).toBe(1)
  }, 20_000)
})
