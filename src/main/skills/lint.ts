import type {
  SkillFinding,
  SkillHealth,
  SkillLintReport,
  SkillLintSeverity,
  SkillMeta
} from '@shared/types'
import type { RiskLevel } from '../gateway/types'

/**
 * Skill health checks.
 *
 * Two sources, both of which say these should be checked rather than trusted:
 * 架构规范 §11's pre-flight checklist, and Connector Gateway 设计文档 §4's
 * request for a script that catches the "两张皮" case - a Skill that promises
 * to be careful while the Gateway has no guard set for what it touches.
 *
 * Pure by design: it takes parsed skills and a connector risk map, so it can be
 * tested without a Gateway and run without one configured.
 */

/** What the Gateway knows about one connector, reduced to what lint needs. */
export interface ConnectorRiskSummary {
  id: string
  /** True when at least one of its tools is write-irreversible. */
  hasIrreversible: boolean
  /** True when every tool it exposes is read-only. */
  allReadOnly: boolean
}

/** Line count past which 架构规范 §4.2 says to split into a Skill Tree. */
const SPLIT_THRESHOLD = 150

export function summariseConnectors(
  tools: Array<{ connectorId: string; risk: RiskLevel }>
): Map<string, ConnectorRiskSummary> {
  const byConnector = new Map<string, RiskLevel[]>()
  for (const tool of tools) {
    const list = byConnector.get(tool.connectorId) ?? []
    list.push(tool.risk)
    byConnector.set(tool.connectorId, list)
  }

  const out = new Map<string, ConnectorRiskSummary>()
  for (const [id, risks] of byConnector) {
    out.set(id, {
      id,
      hasIrreversible: risks.includes('write-irreversible'),
      allReadOnly: risks.length > 0 && risks.every((r) => r === 'read-only')
    })
  }
  return out
}

/**
 * Pull connector ids out of a skill's free-text "依赖的 Application" lines.
 *
 * The field is prose - `fetch-cli（connectors/fetch-cli，见 Application 层）` -
 * so this matches known connector ids as whole words inside it rather than
 * trying to parse a format the template never promised. A dependency written
 * in a way no id matches simply produces no cross-check, which is why
 * `unknown-connector` is an info rather than an error.
 */
export function referencedConnectors(skill: SkillMeta, known: Iterable<string>): {
  matched: string[]
  unmatched: string[]
} {
  const ids = [...known].sort((a, b) => b.length - a.length)
  const matched = new Set<string>()
  const unmatched: string[] = []

  for (const line of skill.guardrails.connectors) {
    const lower = line.toLowerCase()
    const hit = ids.find((id) => {
      const at = lower.indexOf(id.toLowerCase())
      if (at === -1) return false
      // Whole-token match, so `weibo` does not match `weibo-post-legacy`.
      const before = lower[at - 1]
      const after = lower[at + id.length]
      const boundary = (c: string | undefined): boolean => c === undefined || !/[\w-]/.test(c)
      return boundary(before) && boundary(after)
    })
    if (hit) matched.add(hit)
    else unmatched.push(line)
  }

  return { matched: [...matched], unmatched }
}

interface RuleContext {
  skill: SkillMeta
  connectors: Map<string, ConnectorRiskSummary>
  /** skill ids sharing each trigger, lowercased. */
  triggerOwners: Map<string, string[]>
}

function finding(
  skill: SkillMeta,
  rule: SkillFinding['rule'],
  severity: SkillLintSeverity,
  message: string,
  hint: string
): SkillFinding {
  return { skillId: skill.id, rule, severity, message, hint }
}

function checkSkill(ctx: RuleContext): SkillFinding[] {
  const { skill, connectors, triggerOwners } = ctx
  const out: SkillFinding[] = []
  const g = skill.guardrails

  if (!skill.description.trim()) {
    out.push(
      finding(
        skill,
        'no-description',
        'warning',
        '没有 description',
        'agent 靠 description 做对话触发匹配，空着等于只能靠命令行调用'
      )
    )
  }

  if (skill.triggers.length === 0) {
    out.push(
      finding(skill, 'no-triggers', 'info', '没有声明 triggers', '补一个 /slash 触发词便于面板和命令行调用')
    )
  }

  // 架构规范 §11: every skill states what it must never do.
  if (g.forbidden.length === 0) {
    out.push(
      finding(
        skill,
        'missing-forbidden',
        'error',
        '没有声明「绝对不能做的事」',
        '架构规范 §4.1 要求每个 Skill 都写明护栏，无人值守时这是唯一的书面约束'
      )
    )
  }

  // An empty list is a valid statement ("no high-risk actions"); a missing
  // section means nobody considered the question.
  if (g.confirmRequired.length === 0 && g.connectors.length > 0) {
    out.push(
      finding(
        skill,
        'missing-confirm-section',
        'warning',
        '依赖了 Application 却没声明任何「需要人工确认的动作」',
        '确认这个 Skill 真的全程只读；若是，在该章节明确写出来'
      )
    )
  }

  if (skill.lines > SPLIT_THRESHOLD) {
    out.push(
      finding(
        skill,
        'too-long',
        'info',
        `${skill.lines} 行，超过 ${SPLIT_THRESHOLD} 行`,
        '架构规范 §4.2：拆成 Skill Tree，SKILL.md 只做路由'
      )
    )
  }

  for (const trigger of skill.triggers) {
    const owners = triggerOwners.get(trigger.trim().toLowerCase()) ?? []
    const others = owners.filter((id) => id !== skill.id)
    if (others.length > 0) {
      out.push(
        finding(
          skill,
          'trigger-conflict',
          'error',
          `触发词 ${trigger} 与 ${others.join('、')} 冲突`,
          '架构规范 §11：新建 Skill 前先查 SKILLS_INDEX.md，触发词必须唯一'
        )
      )
    }
  }

  // The 两张皮 check, in both directions.
  const { matched, unmatched } = referencedConnectors(skill, connectors.keys())

  for (const line of unmatched) {
    out.push(
      finding(
        skill,
        'unknown-connector',
        'info',
        `「${line}」在 Gateway manifest 里找不到对应 connector`,
        '要么补进 connectors/manifest.yaml，要么这条依赖已经过期'
      )
    )
  }

  for (const id of matched) {
    const summary = connectors.get(id)
    if (!summary) continue

    if (summary.hasIrreversible && g.confirmRequired.length === 0) {
      out.push(
        finding(
          skill,
          'unguarded-irreversible',
          'error',
          `依赖的 ${id} 含不可逆动作，但本 Skill 没声明任何需要确认的动作`,
          'Gateway 仍会拦截，但 Skill 文档与实际风险不符——补上「需要人工确认的动作」'
        )
      )
    }

    if (summary.allReadOnly && g.confirmRequired.length > 0) {
      out.push(
        finding(
          skill,
          'overstated-risk',
          'warning',
          `本 Skill 声称有高风险动作，但 ${id} 在 manifest 里全部标为 read-only`,
          'Connector Gateway 设计文档 §4 的两张皮：要么 manifest 漏标，要么 Skill 写错了'
        )
      )
    }
  }

  return out
}

export interface LintOptions {
  skills: SkillMeta[]
  /** Gateway tools, when a Gateway is configured. Empty disables cross-checks. */
  tools?: Array<{ connectorId: string; risk: RiskLevel }>
}

export function lintSkills({ skills, tools }: LintOptions): SkillLintReport {
  const connectors = summariseConnectors(tools ?? [])

  const triggerOwners = new Map<string, string[]>()
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const key = trigger.trim().toLowerCase()
      if (!key) continue
      triggerOwners.set(key, [...(triggerOwners.get(key) ?? []), skill.id])
    }
  }

  const findings = skills.flatMap((skill) =>
    checkSkill({ skill, connectors, triggerOwners })
  )

  const health = new Map<string, SkillHealth>()
  for (const skill of skills) {
    health.set(skill.id, { skillId: skill.id, errors: 0, warnings: 0, infos: 0 })
  }
  for (const item of findings) {
    const entry = health.get(item.skillId)
    if (!entry) continue
    if (item.severity === 'error') entry.errors += 1
    else if (item.severity === 'warning') entry.warnings += 1
    else entry.infos += 1
  }

  return {
    findings,
    health: [...health.values()],
    connectorsChecked: connectors.size > 0,
    generatedAt: new Date().toISOString()
  }
}
