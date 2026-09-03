import { describe, expect, it } from 'vitest'
import { quoteWindowsArg } from '@main/agents/spawn'
import { previewCommand } from '@main/agents/types'

describe('quoteWindowsArg', () => {
  it('leaves a plain token alone', () => {
    expect(quoteWindowsArg('-p')).toBe('-p')
    expect(quoteWindowsArg('claude')).toBe('claude')
    expect(quoteWindowsArg('/news-digest')).toBe('/news-digest')
  })

  it('quotes anything containing whitespace', () => {
    expect(quoteWindowsArg('/news-digest today')).toBe('"/news-digest today"')
  })

  it('quotes cmd.exe metacharacters that would otherwise be interpreted', () => {
    for (const arg of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a%PATH%b', '(a)', 'a!b']) {
      expect(quoteWindowsArg(arg).startsWith('"')).toBe(true)
    }
  })

  it('escapes embedded double quotes', () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('doubles trailing backslashes so they cannot escape the closing quote', () => {
    // C:\path with space\   ->   "C:\path with space\\"
    expect(quoteWindowsArg('C:\\path with space\\')).toBe('"C:\\path with space\\\\"')
  })

  it('doubles the backslashes that precede an embedded quote', () => {
    // a\"b   ->   "a\\\"b"
    expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"')
  })

  it('represents an empty argument explicitly', () => {
    expect(quoteWindowsArg('')).toBe('""')
  })
})

describe('previewCommand', () => {
  it('renders an auditable one-liner', () => {
    expect(previewCommand({ command: 'claude', args: ['-p', '/news-digest', '--model', 'x'] })).toBe(
      'claude -p /news-digest --model x'
    )
  })

  it('quotes arguments containing spaces', () => {
    expect(previewCommand({ command: 'claude', args: ['-p', '/a b'] })).toBe('claude -p "/a b"')
  })
})
