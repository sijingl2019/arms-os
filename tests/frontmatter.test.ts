import { describe, expect, it } from 'vitest'
import { parseFrontmatter, readString, readStringList } from '@main/skills/frontmatter'

describe('parseFrontmatter', () => {
  it('splits YAML frontmatter from the body', () => {
    const { data, body } = parseFrontmatter('---\nname: demo\n---\n\n## Body\ntext\n')
    expect(data['name']).toBe('demo')
    expect(body.trim()).toBe('## Body\ntext')
  })

  it('treats a file with no frontmatter as all body', () => {
    const { data, body } = parseFrontmatter('## Just markdown\n')
    expect(data).toEqual({})
    expect(body).toBe('## Just markdown\n')
  })

  it('tolerates a BOM and CRLF line endings', () => {
    const { data } = parseFrontmatter('﻿---\r\nname: demo\r\n---\r\nbody\r\n')
    expect(data['name']).toBe('demo')
  })

  it('does not mistake a horizontal rule for a frontmatter fence', () => {
    const { data, body } = parseFrontmatter('intro\n\n---\n\nmore\n')
    expect(data).toEqual({})
    expect(body).toContain('intro')
  })

  it('throws on malformed YAML so the caller can warn and continue', () => {
    expect(() => parseFrontmatter('---\nname: [unclosed\n---\nbody\n')).toThrow()
  })

  it('rejects frontmatter that is not a mapping', () => {
    expect(() => parseFrontmatter('---\n- a\n- b\n---\nbody\n')).toThrow(/mapping/)
  })
})

describe('field readers', () => {
  it('trims strings and nulls out blanks', () => {
    expect(readString({ a: '  x  ' }, 'a')).toBe('x')
    expect(readString({ a: '   ' }, 'a')).toBeNull()
    expect(readString({}, 'a')).toBeNull()
  })

  it('accepts a list written as a bare string', () => {
    expect(readStringList({ triggers: '/one' }, 'triggers')).toEqual(['/one'])
    expect(readStringList({ triggers: ['/one', '  ', '/two'] }, 'triggers')).toEqual([
      '/one',
      '/two'
    ])
    expect(readStringList({}, 'triggers')).toEqual([])
  })
})
