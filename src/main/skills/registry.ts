import type { RefreshResult, SkillGuardrails, SkillMeta, SkillSource } from '@shared/types'
import type { ArmsBus } from '../bus'
import type { ArmsConfig } from '../config'
import type { Db } from '../db'
import { parseSkillFile } from './parse'
import { scanSkillFiles } from './scan'

interface SkillRow {
  id: string
  name: string
  description: string
  source: string
  path: string
  triggers: string
  model_hint: string | null
  effort_hint: string | null
  forbidden: string
  confirm_required: string
  connectors: string
  lines: number
  content_hash: string
  indexed_at: string
}

function jsonList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function toMeta(row: SkillRow): SkillMeta {
  const guardrails: SkillGuardrails = {
    forbidden: jsonList(row.forbidden),
    confirmRequired: jsonList(row.confirm_required),
    connectors: jsonList(row.connectors)
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source as SkillSource,
    path: row.path,
    triggers: jsonList(row.triggers),
    modelHint: row.model_hint,
    effortHint: row.effort_hint,
    guardrails,
    lines: row.lines,
    contentHash: row.content_hash,
    indexedAt: row.indexed_at
  }
}

export interface SkillRegistryDeps {
  db: Db
  config: ArmsConfig
  bus?: ArmsBus
}

/**
 * Owns the `skills` table: an index cache over the SKILL.md files, which remain
 * the source of truth (系统设计文档 §7). Read-only with respect to the outside
 * world - it never spawns anything and never touches credentials.
 */
export class SkillRegistry {
  private readonly db: Db
  private readonly config: ArmsConfig
  private readonly bus: ArmsBus | undefined

  constructor({ db, config, bus }: SkillRegistryDeps) {
    this.db = db
    this.config = config
    this.bus = bus
  }

  /**
   * Sweep every scan root and reconcile the table. Unchanged files are detected
   * by content hash and skipped, so a rescan over a large skill library is
   * cheap. Later scan roots override earlier ones on an id clash, which is how
   * a workspace skill shadows a same-named user skill.
   */
  async refresh(): Promise<RefreshResult> {
    const now = new Date().toISOString()
    const { files, warnings } = await scanSkillFiles(this.config.scanRoots)

    const parsed = new Map<string, SkillMeta>()
    for (const entry of files) {
      const outcome = await parseSkillFile(entry, now)
      if (outcome.warning) warnings.push(outcome.warning)
      if (!outcome.skill) continue

      const previous = parsed.get(outcome.skill.id)
      if (previous) {
        warnings.push(
          `duplicate skill id "${outcome.skill.id}": ${outcome.skill.path} shadows ${previous.path}`
        )
      }
      parsed.set(outcome.skill.id, outcome.skill)
    }

    const existing = new Map(
      (this.db.prepare('SELECT id, content_hash FROM skills').all() as Array<{
        id: string
        content_hash: string
      }>).map((row) => [row.id, row.content_hash])
    )

    const result: RefreshResult = { added: 0, updated: 0, removed: 0, unchanged: 0, warnings }

    const upsert = this.db.prepare(`
      INSERT INTO skills (id, name, description, source, path, triggers, model_hint,
                          effort_hint, forbidden, confirm_required, connectors, lines,
                          content_hash, indexed_at)
      VALUES (@id, @name, @description, @source, @path, @triggers, @model_hint,
              @effort_hint, @forbidden, @confirm_required, @connectors, @lines,
              @content_hash, @indexed_at)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, description = excluded.description,
        source = excluded.source, path = excluded.path, triggers = excluded.triggers,
        model_hint = excluded.model_hint, effort_hint = excluded.effort_hint,
        forbidden = excluded.forbidden, confirm_required = excluded.confirm_required,
        connectors = excluded.connectors, lines = excluded.lines,
        content_hash = excluded.content_hash, indexed_at = excluded.indexed_at
    `)
    const remove = this.db.prepare('DELETE FROM skills WHERE id = ?')

    this.db.transaction(() => {
      for (const skill of parsed.values()) {
        const before = existing.get(skill.id)
        if (before === skill.contentHash) {
          result.unchanged += 1
          continue
        }
        upsert.run({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          path: skill.path,
          triggers: JSON.stringify(skill.triggers),
          model_hint: skill.modelHint,
          effort_hint: skill.effortHint,
          forbidden: JSON.stringify(skill.guardrails.forbidden),
          confirm_required: JSON.stringify(skill.guardrails.confirmRequired),
          connectors: JSON.stringify(skill.guardrails.connectors),
          lines: skill.lines,
          content_hash: skill.contentHash,
          indexed_at: skill.indexedAt
        })
        if (before === undefined) result.added += 1
        else result.updated += 1
      }

      for (const id of existing.keys()) {
        if (parsed.has(id)) continue
        remove.run(id)
        result.removed += 1
      }
    })()

    this.bus?.emit('skills:index:updated', result)
    return result
  }

  list(): SkillMeta[] {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY id').all() as SkillRow[]
    return rows.map(toMeta)
  }

  get(id: string): SkillMeta | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
      | SkillRow
      | undefined
    return row ? toMeta(row) : undefined
  }

  /**
   * Resolve free text to skills. A slash trigger matches when the text starts
   * with it (so `/news-digest today` still resolves); a prose trigger matches
   * when it appears anywhere in the text.
   */
  findByTrigger(text: string): SkillMeta[] {
    const needle = text.trim().toLowerCase()
    if (!needle) return []

    return this.list().filter((skill) =>
      skill.triggers.some((trigger) => {
        const t = trigger.trim().toLowerCase()
        if (!t) return false
        return t.startsWith('/') ? needle === t || needle.startsWith(`${t} `) : needle.includes(t)
      })
    )
  }
}
