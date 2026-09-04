import { execFile } from 'node:child_process'
import type { GitCommit, GitStatus } from '@shared/types'

/**
 * Read-only Git inspection for the desktop's Git widget.
 *
 * There is deliberately no write path here - no commit, checkout or pull - so
 * nothing in this module needs to pass the Connector Gateway's Guardrail. The
 * Guardrail exists for agent-initiated actions on the outside world; this is
 * the dashboard reading its own working copy.
 */

/** Commands are cheap; a hang is the only realistic failure worth bounding. */
const TIMEOUT_MS = 5_000
const LOG_FORMAT = '%h%x09%an%x09%ad%x09%s'
const RECENT_COMMITS = 5

/** Everything a caller can learn from a failed inspection. */
function failed(error: string): GitStatus {
  return {
    isRepo: false,
    branch: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    commits: [],
    error
  }
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * v2 rather than v1 because the `# branch.ab` header carries ahead/behind
 * without a second command, and the two-character XY field lets one pass
 * separate staged from unstaged changes.
 */
export function parseGitStatusV2(stdout: string): Omit<GitStatus, 'commits' | 'error'> {
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      // git reports the literal string "(detached)" rather than a name.
      branch = head === '(detached)' ? null : head
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
      continue
    }
    if (line.startsWith('#')) continue

    if (line.startsWith('? ')) {
      untracked += 1
      continue
    }
    if (line.startsWith('! ')) continue // ignored

    // '1' ordinary change, '2' rename/copy: both put XY in the second field.
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      if (xy[0] !== '.') staged += 1
      if (xy[1] !== '.') unstaged += 1
      continue
    }
    // 'u' unmerged: a conflict is work in the tree, not something staged.
    if (line.startsWith('u ')) unstaged += 1
  }

  return { isRepo: true, branch, ahead, behind, staged, unstaged, untracked }
}

/** Parse the tab-separated `git log` lines produced by LOG_FORMAT. */
export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    // The subject may itself contain tabs, so only split off the first three.
    const parts = line.split('\t')
    if (parts.length < 4) continue
    commits.push({
      hash: parts[0] ?? '',
      author: parts[1] ?? '',
      date: parts[2] ?? '',
      subject: parts.slice(3).join('\t')
    })
  }
  return commits
}

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      }
    )
  })
}

/**
 * Inspect `cwd`. Never throws: a missing git binary, a non-repository
 * directory and a timeout all collapse into `{ isRepo: false, error }`, because
 * a widget on the desktop must degrade to one grey line, not to a broken IPC.
 */
export async function readGitStatus(cwd: string): Promise<GitStatus> {
  let statusOut: string
  try {
    statusOut = await run(['status', '--porcelain=v2', '--branch'], cwd)
  } catch (err) {
    const message = (err as Error).message
    if (/ENOENT/.test(message)) return failed('git is not on PATH')
    if (/not a git repository/i.test(message)) return failed('不是 Git 仓库')
    return failed(message.split('\n')[0] ?? 'git status failed')
  }

  const parsed = parseGitStatusV2(statusOut)

  // A fresh repository has no commits yet; that is not an error worth showing.
  let commits: GitCommit[] = []
  try {
    commits = parseGitLog(
      await run(['log', `-${RECENT_COMMITS}`, `--pretty=format:${LOG_FORMAT}`, '--date=short'], cwd)
    )
  } catch {
    commits = []
  }

  return { ...parsed, commits, error: null }
}
