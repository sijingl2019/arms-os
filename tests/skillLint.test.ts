import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lintSkills, referencedConnectors, summariseConnectors } from '@main/skills/lint'
import {
  createSkill,
  normaliseTrigger,
  renderSkillTemplate,
  validateSkillId
} from '@main/skills/scaffold'
import type { RiskLevel } from '@main/gateway/types'
import type { SkillLintRule, SkillMeta } from '@shared/types'

function skill(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    id: 'news-digest',
    name: 'news-digest',
    description: '每日资讯摘要',
    source: 'workspace',
    path: '/w/.claude/skills/news-digest/SKILL.md',
    triggers: ['/news-digest'],
    modelHint: null,
    effortHint: null,
    guardrails: { forbidden: ['不自动发布'], confirmRequired: [], connectors: [] },
    lines: 30,
    contentHash: 'h',
    indexedAt: '2026-09-04T00:00:00.000Z',
    ...overrides
  }
}

const tool = (connectorId: string, risk: RiskLevel) => ({ connectorId, risk })

function rules(skills: SkillMeta[], tools?: Array<{ connectorId: string; risk: RiskLevel }>): SkillLintRule[] {
  return lintSkills({ skills, ...(tools ? { tools } : {}) }).findings.map((f) => f.rule)
}

describe('checklist rules (架构规范 §11)', () => {
  it('passes a well-formed skill', () => {
    expect(rules([skill()])).toEqual([])
  })

  it('flags a missing guardrail section as an error', () => {
    const found = lintSkills({
      skills: [skill({ guardrails: { forbidden: [], confirmRequired: [], connectors: [] } })]
    })
    const item = found.findings.find((f) => f.rule === 'missing-forbidden')
    expect(item?.severity).toBe('error')
  })

  it('flags an empty description and missing triggers', () => {
    expect(rules([skill({ description: '  ', triggers: [] })])).toEqual(
      expect.arrayContaining(['no-description', 'no-triggers'])
    )
  })

  it('suggests a Skill Tree split past 150 lines', () => {
    expect(rules([skill({ lines: 240 })])).toContain('too-long')
    expect(rules([skill({ lines: 150 })])).not.toContain('too-long')
  })

  it('reports a trigger collision on both skills', () => {
    const report = lintSkills({
      skills: [
        skill({ id: 'a', triggers: ['/publish'] }),
        skill({ id: 'b', triggers: ['/PUBLISH'] })
      ]
    })
    const conflicts = report.findings.filter((f) => f.rule === 'trigger-conflict')
    expect(conflicts.map((f) => f.skillId).sort()).toEqual(['a', 'b'])
    expect(conflicts[0]?.severity).toBe('error')
  })

  it('does not call a skill a conflict with itself', () => {
    expect(rules([skill({ triggers: ['/x', '/x'] })])).not.toContain('trigger-conflict')
  })

  it('counts findings per skill', () => {
    const report = lintSkills({
      skills: [
        skill({
          id: 'bad',
          triggers: ['/bad'],
          description: '',
          guardrails: { forbidden: [], confirmRequired: [], connectors: [] }
        }),
        skill({ id: 'good', triggers: ['/good'] })
      ]
    })
    expect(report.health).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ skillId: 'bad', errors: 1, warnings: 1 }),
        expect.objectContaining({ skillId: 'good', errors: 0, warnings: 0, infos: 0 })
      ])
    )
  })
})

describe('connector cross-check (Connector Gateway 设计文档 §4)', () => {
  const tools = [
    tool('weibo-post', 'write-irreversible'),
    tool('weibo-post', 'read-only'),
    tool('fetch-cli', 'read-only')
  ]

  it('summarises each connector by its riskiest tool', () => {
    const summary = summariseConnectors(tools)
    expect(summary.get('weibo-post')).toMatchObject({ hasIrreversible: true, allReadOnly: false })
    expect(summary.get('fetch-cli')).toMatchObject({ hasIrreversible: false, allReadOnly: true })
  })

  it('catches a skill that touches an irreversible connector without declaring it', () => {
    // The 两张皮 case: the Skill promises nothing, the Gateway guards anyway.
    const report = lintSkills({
      skills: [
        skill({
          guardrails: {
            forbidden: ['x'],
            confirmRequired: [],
            connectors: ['weibo-post（connectors/weibo-post）']
          }
        })
      ],
      tools
    })
    const item = report.findings.find((f) => f.rule === 'unguarded-irreversible')
    expect(item?.severity).toBe('error')
    expect(item?.message).toContain('weibo-post')
  })

  it('catches the opposite: a skill claiming risk a read-only connector cannot have', () => {
    const report = lintSkills({
      skills: [
        skill({
          guardrails: {
            forbidden: ['x'],
            confirmRequired: ['发布到微博'],
            connectors: ['fetch-cli（connectors/fetch-cli，见 Application 层）']
          }
        })
      ],
      tools
    })
    expect(report.findings.map((f) => f.rule)).toContain('overstated-risk')
  })

  it('accepts a skill whose declaration matches the manifest', () => {
    const report = lintSkills({
      skills: [
        skill({
          guardrails: {
            forbidden: ['x'],
            confirmRequired: ['发布到微博'],
            connectors: ['weibo-post']
          }
        })
      ],
      tools
    })
    expect(report.findings).toEqual([])
  })

  it('reports a dependency the manifest has never heard of', () => {
    const report = lintSkills({
      skills: [
        skill({ guardrails: { forbidden: ['x'], confirmRequired: [], connectors: ['telepathy-cli'] } })
      ],
      tools
    })
    const item = report.findings.find((f) => f.rule === 'unknown-connector')
    // Info, not an error: the field is prose, so a miss may just be phrasing.
    expect(item?.severity).toBe('info')
  })

  it('runs the checklist but skips cross-checks when no Gateway is configured', () => {
    const report = lintSkills({
      skills: [
        skill({ guardrails: { forbidden: ['x'], confirmRequired: [], connectors: ['weibo-post'] } })
      ]
    })
    expect(report.connectorsChecked).toBe(false)
    expect(report.findings.map((f) => f.rule)).not.toContain('unguarded-irreversible')
  })
})

describe('referencedConnectors', () => {
  const known = ['weibo-post', 'gmail', 'fetch']

  it('finds an id embedded in prose', () => {
    const s = skill({
      guardrails: {
        forbidden: [],
        confirmRequired: [],
        connectors: ['weibo-post（connectors/weibo-post/cli.js）', 'gmail 官方 MCP']
      }
    })
    expect(referencedConnectors(s, known).matched.sort()).toEqual(['gmail', 'weibo-post'])
  })

  it('matches whole tokens only', () => {
    const s = skill({
      guardrails: { forbidden: [], confirmRequired: [], connectors: ['fetch-cli-legacy'] }
    })
    // `fetch` must not claim `fetch-cli-legacy`.
    expect(referencedConnectors(s, known).matched).toEqual([])
    expect(referencedConnectors(s, known).unmatched).toHaveLength(1)
  })

  it('prefers the longest matching id', () => {
    const s = skill({
      guardrails: { forbidden: [], confirmRequired: [], connectors: ['weibo-post'] }
    })
    expect(referencedConnectors(s, ['weibo', 'weibo-post']).matched).toEqual(['weibo-post'])
  })
})

describe('scaffold', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'arms-scaffold-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  it.each([
    ['', 'empty'],
    ['Has Caps', 'caps'],
    ['has space', 'space'],
    ['-leading', 'leading dash']
  ])('rejects a malformed id (%s)', (id) => {
    expect(validateSkillId(id)).not.toBeNull()
  })

  it('accepts a normal id', () => {
    expect(validateSkillId('news-digest')).toBeNull()
  })

  it('renders a template that already passes lint', async () => {
    const created = await createSkill({ id: 'demo', description: '示例' }, dir)
    const body = readFileSync(created.file, 'utf8')

    expect(body).toContain('name: demo')
    expect(body).toContain('绝对不能做的事')
    expect(body).toContain('需要人工确认的动作')
    expect(body).toContain('依赖的 Application')
  })

  it('includes every guardrail section, since a remembered one gets skipped', () => {
    const body = renderSkillTemplate({ id: 'x' })
    for (const section of ['## 这个 Skill 做什么', '## 绝对不能做的事', '## 需要人工确认的动作']) {
      expect(body).toContain(section)
    }
  })

  it('refuses to overwrite an existing skill', async () => {
    await createSkill({ id: 'demo' }, dir)
    await expect(createSkill({ id: 'demo' }, dir)).rejects.toThrow(/已存在/)
  })

  it('defaults the trigger to the skill id', () => {
    expect(renderSkillTemplate({ id: 'demo' })).toContain('- "/demo"')
  })

  it('repairs a trigger mangled by Git Bash path conversion', () => {
    // Observed for real: `--trigger /publish` arrives as a Windows path.
    expect(normaliseTrigger('D:/Softwares/Git/publish')).toBe('/publish')
    expect(normaliseTrigger('C:\\Program Files\\Git\\news')).toBe('/news')
  })

  it('leaves a normal trigger alone', () => {
    expect(normaliseTrigger('/publish')).toBe('/publish')
    expect(normaliseTrigger('今天有什么新闻')).toBe('今天有什么新闻')
  })

  it('writes the repaired trigger into the template', () => {
    expect(renderSkillTemplate({ id: 'demo', triggers: ['D:/Softwares/Git/publish'] })).toContain(
      '- "/publish"'
    )
  })
})
