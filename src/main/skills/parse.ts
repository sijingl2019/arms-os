import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { SkillMeta } from '@shared/types'
import { parseFrontmatter, readString, readStringList } from './frontmatter'
import { parseGuardrails } from './guardrails'
import type { SkillFile } from './scan'

export interface ParseOutcome {
  skill: SkillMeta | null
  /** Set when the file was skipped or partially understood. */
  warning?: string
}

export function hashContent(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Parse an already-read SKILL.md. Split out from `parseSkillFile` for tests. */
export function parseSkillContent(entry: SkillFile, raw: string, now: string): ParseOutcome {
  let data: Record<string, unknown> = {}
  let body = raw
  let warning: string | undefined

  try {
    const fm = parseFrontmatter(raw)
    data = fm.data
    body = fm.body
  } catch (err) {
    // Broken frontmatter degrades the entry to name+guardrails rather than
    // dropping the skill entirely - a half-indexed skill still beats a hole.
    warning = `${entry.file}: ${(err as Error).message}`
  }

  const name = readString(data, 'name') ?? entry.dirName
  const skill: SkillMeta = {
    id: name,
    name,
    description: readString(data, 'description') ?? '',
    source: entry.source,
    path: entry.file,
    triggers: readStringList(data, 'triggers'),
    modelHint: readString(data, 'model_hint') ?? readString(data, 'modelHint'),
    effortHint: readString(data, 'effort_hint') ?? readString(data, 'effortHint'),
    guardrails: parseGuardrails(body),
    lines: raw.split('\n').length,
    contentHash: hashContent(raw),
    indexedAt: now
  }

  return warning === undefined ? { skill } : { skill, warning }
}

/**
 * Read and parse one SKILL.md. An unreadable file yields a warning and no
 * skill; the caller keeps sweeping (系统设计文档 §9).
 */
export async function parseSkillFile(entry: SkillFile, now: string): Promise<ParseOutcome> {
  let raw: string
  try {
    raw = await fs.readFile(entry.file, 'utf8')
  } catch (err) {
    return { skill: null, warning: `${entry.file}: unreadable (${(err as Error).message})` }
  }
  return parseSkillContent(entry, raw, now)
}
