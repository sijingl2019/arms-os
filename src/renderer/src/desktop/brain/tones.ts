/**
 * The cloud wears the four ARMS layer colours, defined as CSS custom properties
 * so a retheme carries the core with it. Canvas has no `var()` of its own,
 * hence the hex-to-HSL conversion here; reading the properties off the document
 * is the canvas component's job, since this module stays DOM-free to keep it
 * testable.
 */

export interface Tone {
  h: number
  s: number
}

/** Applications / Routines / Memory / Skills, in that order. */
export const TONE_VARS = ['--tone-apps', '--tone-routines', '--tone-memory', '--tone-skills'] as const

/** Used only if a token is missing or in a format we cannot parse. */
export const FALLBACK_TONES: readonly Tone[] = [
  { h: 210, s: 100 },
  { h: 22, s: 100 },
  { h: 275, s: 95 },
  { h: 152, s: 62 }
]

/** `#rrggbb` (with or without the hash) to hue plus saturation. */
export function hexToTone(css: string): Tone | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim())
  if (!m?.[1]) return null
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min

  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }

  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { h, s: Math.round(Math.min(1, s) * 100) }
}
