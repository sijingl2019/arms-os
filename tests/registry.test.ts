import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArmsBus } from '@main/bus'
import { SkillRegistry } from '@main/skills/registry'
import type { RefreshResult } from '@shared/types'
import { createHarness, skillDoc, type Harness } from './helpers'

let h: Harness
let registry: SkillRegistry
let bus: ArmsBus

beforeEach(() => {
  h = createHarness()
  bus = new ArmsBus()
  registry = new SkillRegistry({ db: h.db, config: h.config, bus })
})

afterEach(() => {
  h.db.close()
  h.cleanup()
})

describe('SkillRegistry.refresh', () => {
  it('indexes skills from every scan root and tags their source', async () => {
    h.writeSkill('user', 'news-digest', skillDoc({ name: 'news-digest' }))
    h.writeSkill('workspace', 'post-publisher', skillDoc({ name: 'post-publisher' }))

    const result = await registry.refresh()
    expect(result.added).toBe(2)
    expect(registry.get('news-digest')?.source).toBe('user')
    expect(registry.get('post-publisher')?.source).toBe('workspace')
  })

  it('stores frontmatter hints and parsed guardrails', async () => {
    h.writeSkill(
      'workspace',
      'post-publisher',
      skillDoc({
        name: 'post-publisher',
        description: '发布内容到社媒',
        triggers: ['/publish', '帮我发一条'],
        modelHint: 'claude-sonnet-5',
        effortHint: 'medium',
        forbidden: ['不发布未经审阅的内容'],
        confirm: ['发布到微博'],
        connectors: ['weibo-post']
      })
    )
    await registry.refresh()

    const skill = registry.get('post-publisher')
    expect(skill?.description).toBe('发布内容到社媒')
    expect(skill?.triggers).toEqual(['/publish', '帮我发一条'])
    expect(skill?.modelHint).toBe('claude-sonnet-5')
    expect(skill?.effortHint).toBe('medium')
    expect(skill?.guardrails.confirmRequired).toEqual(['发布到微博'])
    expect(skill?.guardrails.connectors).toEqual(['weibo-post'])
  })

  it('reports unchanged skills instead of rewriting them', async () => {
    h.writeSkill('user', 'a', skillDoc({ name: 'a' }))
    await registry.refresh()

    const second = await registry.refresh()
    expect(second).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 1 })
  })

  it('detects an edit through the content hash', async () => {
    const file = h.writeSkill('user', 'a', skillDoc({ name: 'a', description: 'before' }))
    await registry.refresh()

    writeFileSync(file, skillDoc({ name: 'a', description: 'after' }), 'utf8')
    const result = await registry.refresh()

    expect(result).toMatchObject({ added: 0, updated: 1, unchanged: 0 })
    expect(registry.get('a')?.description).toBe('after')
  })

  it('drops skills whose files disappeared', async () => {
    h.writeSkill('user', 'gone', skillDoc({ name: 'gone' }))
    await registry.refresh()

    rmSync(path.join(h.dir, 'user-skills', 'gone'), { recursive: true, force: true })
    const result = await registry.refresh()

    expect(result.removed).toBe(1)
    expect(registry.get('gone')).toBeUndefined()
  })

  it('lets a workspace skill shadow a same-named user skill, and warns', async () => {
    h.writeSkill('user', 'dup', skillDoc({ name: 'dup', description: 'user copy' }))
    h.writeSkill('workspace', 'dup', skillDoc({ name: 'dup', description: 'workspace copy' }))

    const result = await registry.refresh()
    expect(registry.get('dup')?.source).toBe('workspace')
    expect(registry.get('dup')?.description).toBe('workspace copy')
    expect(result.warnings.some((w) => w.includes('duplicate skill id'))).toBe(true)
  })

  it('falls back to the directory name when frontmatter has no name', async () => {
    h.writeSkill('user', 'unnamed', '## 这个 Skill 做什么\n1. 什么也不做\n')
    await registry.refresh()
    expect(registry.get('unnamed')?.name).toBe('unnamed')
  })

  it('warns on broken frontmatter but still indexes the skill', async () => {
    h.writeSkill('user', 'broken', '---\nname: [unclosed\n---\n## 绝对不能做的事\n- 别乱来\n')
    const result = await registry.refresh()

    expect(result.warnings.some((w) => w.includes('broken'))).toBe(true)
    expect(registry.get('broken')?.guardrails.forbidden).toEqual(['别乱来'])
  })

  it('skips subdirectories that hold no SKILL.md', async () => {
    mkdirSync(path.join(h.dir, 'user-skills', 'references'), { recursive: true })
    const result = await registry.refresh()
    expect(result.added).toBe(0)
  })

  it('survives a missing scan root', async () => {
    rmSync(path.join(h.dir, 'user-skills'), { recursive: true, force: true })
    await expect(registry.refresh()).resolves.toMatchObject({ added: 0 })
  })

  it('announces the result on the bus', async () => {
    const seen: RefreshResult[] = []
    bus.on('skills:index:updated', (r) => seen.push(r))
    h.writeSkill('user', 'a', skillDoc({ name: 'a' }))

    await registry.refresh()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.added).toBe(1)
  })
})

describe('SkillRegistry.findByTrigger', () => {
  beforeEach(async () => {
    h.writeSkill(
      'user',
      'news-digest',
      skillDoc({ name: 'news-digest', triggers: ['/news-digest', '今天有什么新闻'] })
    )
    await registry.refresh()
  })

  it('matches a slash trigger exactly or with arguments', () => {
    expect(registry.findByTrigger('/news-digest').map((s) => s.id)).toEqual(['news-digest'])
    expect(registry.findByTrigger('/news-digest today').map((s) => s.id)).toEqual(['news-digest'])
  })

  it('does not match a different slash command with the same prefix', () => {
    expect(registry.findByTrigger('/news-digest-weekly')).toEqual([])
  })

  it('matches a prose trigger anywhere in the text', () => {
    expect(registry.findByTrigger('帮我看看今天有什么新闻吧').map((s) => s.id)).toEqual([
      'news-digest'
    ])
  })

  it('returns nothing for blank input', () => {
    expect(registry.findByTrigger('   ')).toEqual([])
  })
})
