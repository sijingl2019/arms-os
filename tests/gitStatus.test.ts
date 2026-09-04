import { describe, expect, it } from 'vitest'
import { parseGitLog, parseGitStatusV2 } from '@main/git/status'

describe('parseGitStatusV2', () => {
  it('reads the branch and its divergence from upstream', () => {
    const out = [
      '# branch.oid 4d2c1a0',
      '# branch.head feature/desktop',
      '# branch.upstream origin/feature/desktop',
      '# branch.ab +3 -2'
    ].join('\n')

    const status = parseGitStatusV2(out)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('feature/desktop')
    expect(status.ahead).toBe(3)
    expect(status.behind).toBe(2)
  })

  it('reports a detached HEAD as no branch rather than as the literal token', () => {
    expect(parseGitStatusV2('# branch.head (detached)\n').branch).toBeNull()
  })

  it('separates staged, unstaged and untracked changes', () => {
    const out = [
      '# branch.head main',
      // XY = 'M.' - staged only
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
      // XY = '.M' - unstaged only
      '1 .M N... 100644 100644 100644 aaa bbb src/b.ts',
      // XY = 'MM' - counted on both sides
      '1 MM N... 100644 100644 100644 aaa bbb src/c.ts',
      '? notes.md',
      '? scratch.txt',
      '! dist/bundle.js'
    ].join('\n')

    const status = parseGitStatusV2(out)
    expect(status.staged).toBe(2)
    expect(status.unstaged).toBe(2)
    expect(status.untracked).toBe(2)
  })

  it('counts a rename as a change and a conflict as unstaged work', () => {
    const out = [
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
      '1 .M N... 100644 100644 100644 aaa bbb keep.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts'
    ].join('\n')

    const status = parseGitStatusV2(out)
    expect(status.staged).toBe(1)
    expect(status.unstaged).toBe(2)
  })

  it('survives CRLF output and a clean tree', () => {
    const status = parseGitStatusV2('# branch.head main\r\n# branch.ab +0 -0\r\n')
    expect(status.branch).toBe('main')
    expect(status.staged + status.unstaged + status.untracked).toBe(0)
  })
})

describe('parseGitLog', () => {
  it('splits the fixed fields and keeps tabs inside the subject', () => {
    const commits = parseGitLog(
      ['abc1234\tLin\t2026-09-04\tfeat: desktop shell', 'def5678\tLin\t2026-09-03\tfix: a\tb'].join(
        '\n'
      )
    )
    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual({
      hash: 'abc1234',
      author: 'Lin',
      date: '2026-09-04',
      subject: 'feat: desktop shell'
    })
    expect(commits[1]?.subject).toBe('fix: a\tb')
  })

  it('returns nothing for the empty output of a repository with no commits', () => {
    expect(parseGitLog('')).toEqual([])
  })
})
