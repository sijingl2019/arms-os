import { describe, expect, it } from 'vitest'

/**
 * The IMAP connector's shaping logic.
 *
 * The protocol itself belongs to imapflow and is not re-tested here; what is
 * tested is everything between the wire and the widget, because that is where
 * the mistakes that reach a dashboard live.
 */

process.env['ARMS_EMAIL_IMPORT_ONLY'] = '1'
// The connector is plain JS with no declaration file; it is a standalone
// process, not a typed module of the app.
const {
  normalisePassword,
  formatAddress,
  toSummary,
  clampLimit
} = (await import('../connectors/email-imap/server.js' as string)) as {
  normalisePassword(p: string | undefined): string
  formatAddress(a: unknown): string
  toSummary(m: unknown): {
    uid: number
    from: string
    subject: string
    date: string | null
    seen: boolean
  }
  clampLimit(v: unknown): number
}

describe('normalisePassword', () => {
  it('strips the presentational spaces Google shows an app password with', () => {
    expect(normalisePassword('abcd efgh ijkl mnop')).toBe('abcdefghijklmnop')
  })

  it('leaves a password that merely contains spaces alone', () => {
    // Another provider's password may legitimately contain them.
    expect(normalisePassword('correct horse battery staple!')).toBe(
      'correct horse battery staple!'
    )
  })

  it('copes with nothing at all', () => {
    expect(normalisePassword(undefined)).toBe('')
  })
})

describe('formatAddress', () => {
  it('prefers a display name', () => {
    expect(formatAddress([{ name: '张三', address: 'z@example.com' }])).toBe(
      '张三 <z@example.com>'
    )
  })

  it('falls back to the bare address', () => {
    expect(formatAddress([{ address: 'z@example.com' }])).toBe('z@example.com')
  })

  it('accepts a single object as well as a list', () => {
    expect(formatAddress({ address: 'z@example.com' })).toBe('z@example.com')
  })

  it('returns empty for a missing or empty sender', () => {
    expect(formatAddress(undefined)).toBe('')
    expect(formatAddress([])).toBe('')
  })
})

describe('toSummary', () => {
  it('shapes a fetched message into a widget row', () => {
    const row = toSummary({
      uid: 42,
      flags: new Set(['\\Seen']),
      envelope: {
        from: [{ name: 'ACME', address: 'billing@acme.com' }],
        subject: '续约提醒',
        date: new Date('2026-09-04T08:00:00Z')
      }
    })

    expect(row).toEqual({
      uid: 42,
      from: 'ACME <billing@acme.com>',
      subject: '续约提醒',
      date: '2026-09-04T08:00:00.000Z',
      seen: true
    })
  })

  it('says so rather than showing a blank subject', () => {
    expect(toSummary({ uid: 1, envelope: {} }).subject).toBe('(no subject)')
  })

  it('treats a message with no flags as unread', () => {
    expect(toSummary({ uid: 1, envelope: {} }).seen).toBe(false)
  })

  it('survives an envelope with no date', () => {
    expect(toSummary({ uid: 1, envelope: { subject: 'x' } }).date).toBeNull()
  })
})

describe('clampLimit', () => {
  it('defaults when asked for nothing', () => {
    expect(clampLimit(undefined)).toBe(10)
  })

  it('caps a large request, so one call cannot drag a whole mailbox back', () => {
    expect(clampLimit(5000)).toBe(50)
  })

  it('rejects nonsense', () => {
    expect(clampLimit(0)).toBe(10)
    expect(clampLimit(-3)).toBe(10)
    expect(clampLimit('lots')).toBe(10)
  })

  it('honours a sensible request', () => {
    expect(clampLimit(5)).toBe(5)
  })
})
