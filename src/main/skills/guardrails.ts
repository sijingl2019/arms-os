import type { SkillGuardrails } from '@shared/types'

/**
 * Guardrails live in prose sections of SKILL.md, not in frontmatter (架构规范
 * §4.1). We extract them into structured lists so the Connector Gateway can
 * later cross-check a skill's declared high-risk actions against the connector
 * manifest's risk levels (Connector Gateway 设计文档 §4).
 */

type Bucket = keyof SkillGuardrails

/** Matched against a lowercased heading, so keep every needle lowercase. */
const HEADING_KEYWORDS: Array<{ bucket: Bucket; needles: string[] }> = [
  {
    bucket: 'confirmRequired',
    needles: ['人工确认', '需要确认', '确认的动作', 'requires confirmation', 'human confirmation', 'needs approval']
  },
  {
    bucket: 'forbidden',
    needles: ['绝对不能做', '不能做的事', '禁止', '护栏', 'guardrail', 'must not', 'never do', 'forbidden']
  },
  {
    bucket: 'connectors',
    needles: ['依赖的 application', '依赖的application', '依赖的 connector', '依赖的connector', '依赖', 'depends on', 'dependencies', 'required connectors']
  }
]

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/

function classify(heading: string): Bucket | null {
  const lower = heading.toLowerCase()
  for (const { bucket, needles } of HEADING_KEYWORDS) {
    if (needles.some((needle) => lower.includes(needle))) return bucket
  }
  return null
}

/** Strip markdown emphasis and inline code so stored entries read as plain text. */
function clean(item: string): string {
  return item
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .trim()
}

/**
 * A section whose only content is a parenthetical disclaimer - the template's
 * `（本 skill 无高风险动作，全程只读）` - declares an empty list, not a missing one.
 */
export function parseGuardrails(body: string): SkillGuardrails {
  const result: SkillGuardrails = { forbidden: [], confirmRequired: [], connectors: [] }
  let current: Bucket | null = null
  let inFence = false

  for (const line of body.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const heading = HEADING.exec(line)
    if (heading) {
      current = classify(heading[2] ?? '')
      continue
    }

    if (!current) continue
    const item = LIST_ITEM.exec(line)
    if (!item) continue
    const text = clean(item[1] ?? '')
    if (text) result[current].push(text)
  }

  return result
}

/** True when the skill declares at least one action needing a human. */
export function hasHighRiskActions(guardrails: SkillGuardrails): boolean {
  return guardrails.confirmRequired.length > 0
}
