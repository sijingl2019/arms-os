import { parse as parseYaml } from 'yaml'

export interface Frontmatter {
  data: Record<string, unknown>
  /** Everything after the closing delimiter. */
  body: string
}

const OPENING = /^﻿?---\r?\n/
const CLOSING = /\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * Split a SKILL.md into its YAML frontmatter and markdown body. A file with no
 * frontmatter is not an error - it is a skill with no declared metadata, and
 * the caller falls back to the directory name.
 *
 * @throws if the frontmatter block exists but is not valid YAML, so the caller
 *   can record a warning naming the offending file.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const open = OPENING.exec(raw)
  if (!open) return { data: {}, body: raw }

  const rest = raw.slice(open[0].length)
  const close = CLOSING.exec(rest)
  if (!close) return { data: {}, body: raw }

  const yaml = rest.slice(0, close.index)
  const body = rest.slice(close.index + close[0].length)

  const parsed: unknown = parseYaml(yaml)
  if (parsed === null || parsed === undefined) return { data: {}, body }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter must be a YAML mapping')
  }
  return { data: parsed as Record<string, unknown>, body }
}

/** Trimmed string, or null for anything missing/blank/non-scalar. */
export function readString(data: Record<string, unknown>, key: string): string | null {
  const value = data[key]
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/**
 * A list field that authors write either as a YAML sequence or, sloppily, as a
 * single string. Both are accepted.
 */
export function readStringList(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (typeof value === 'string') {
    const one = value.trim()
    return one ? [one] : []
  }
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
}
