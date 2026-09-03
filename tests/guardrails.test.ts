import { describe, expect, it } from 'vitest'
import { hasHighRiskActions, parseGuardrails } from '@main/skills/guardrails'

const DOC = `
## 这个 Skill 做什么
1. 抓取信源
2. 生成摘要

## 绝对不能做的事（护栏）
- 不自动转发/发布到任何外部平台
- 不访问声明之外的信源

## 需要人工确认的动作
- 发布到微博
- 删除远端文件

## 依赖的 Application
- fetch-cli（connectors/fetch-cli）
`

describe('parseGuardrails', () => {
  it('extracts each guardrail section into its own list', () => {
    const g = parseGuardrails(DOC)
    expect(g.forbidden).toEqual([
      '不自动转发/发布到任何外部平台',
      '不访问声明之外的信源'
    ])
    expect(g.confirmRequired).toEqual(['发布到微博', '删除远端文件'])
    expect(g.connectors).toEqual(['fetch-cli（connectors/fetch-cli）'])
  })

  it('reads the template disclaimer as an empty list, not a missing one', () => {
    const g = parseGuardrails('## 需要人工确认的动作\n（本 skill 无高风险动作，全程只读）\n')
    expect(g.confirmRequired).toEqual([])
    expect(hasHighRiskActions(g)).toBe(false)
  })

  it('flags a skill that declares any confirmation-gated action', () => {
    expect(hasHighRiskActions(parseGuardrails(DOC))).toBe(true)
  })

  it('ignores list items inside fenced code blocks', () => {
    const g = parseGuardrails(
      '## 绝对不能做的事\n```\n- this is sample code\n```\n- 真正的护栏\n'
    )
    expect(g.forbidden).toEqual(['真正的护栏'])
  })

  it('strips inline markdown emphasis from entries', () => {
    const g = parseGuardrails('## 绝对不能做的事\n- **never** run `rm -rf`\n')
    expect(g.forbidden).toEqual(['never run rm -rf'])
  })

  it('understands English headings too', () => {
    const g = parseGuardrails(
      '## Must not do\n- delete production data\n\n## Requires confirmation\n- send email\n'
    )
    expect(g.forbidden).toEqual(['delete production data'])
    expect(g.confirmRequired).toEqual(['send email'])
  })

  it('stops collecting when the next heading starts', () => {
    const g = parseGuardrails('## 绝对不能做的事\n- a\n\n## 其他\n- b\n')
    expect(g.forbidden).toEqual(['a'])
  })
})
