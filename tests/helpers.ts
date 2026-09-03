import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type ArmsConfig } from '@main/config'
import { openDb, type Db } from '@main/db'

export interface Harness {
  dir: string
  config: ArmsConfig
  db: Db
  /** Create `<root>/<id>/SKILL.md`. */
  writeSkill(root: 'workspace' | 'user', id: string, content: string): string
  cleanup(): void
}

/**
 * A throwaway workspace with its own scan roots and an in-memory database, so
 * tests never touch the developer's real ~/.claude/skills.
 */
export function createHarness(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arms-test-'))
  const roots = {
    user: path.join(dir, 'user-skills'),
    workspace: path.join(dir, 'workspace', '.claude', 'skills')
  }
  mkdirSync(roots.user, { recursive: true })
  mkdirSync(roots.workspace, { recursive: true })

  const config = loadConfig({
    workspaceRoot: path.join(dir, 'workspace'),
    stateDir: path.join(dir, 'state'),
    dbPath: ':memory:',
    runLogPath: path.join(dir, 'state', 'runs.log'),
    skillsIndexPath: path.join(dir, 'SKILLS_INDEX.md'),
    // user first, workspace last: workspace must win an id clash
    scanRoots: [
      { dir: roots.user, source: 'user' },
      { dir: roots.workspace, source: 'workspace' }
    ]
  })

  return {
    dir,
    config,
    db: openDb(config.dbPath),
    writeSkill(root, id, content) {
      const skillDir = path.join(roots[root], id)
      mkdirSync(skillDir, { recursive: true })
      const file = path.join(skillDir, 'SKILL.md')
      writeFileSync(file, content, 'utf8')
      return file
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A SKILL.md following the 架构规范 §4.1 template. */
export function skillDoc(opts: {
  name: string
  description?: string
  triggers?: string[]
  modelHint?: string
  effortHint?: string
  forbidden?: string[]
  confirm?: string[]
  connectors?: string[]
  extra?: string
}): string {
  const fm = [
    '---',
    `name: ${opts.name}`,
    `description: ${opts.description ?? 'a test skill'}`,
    ...(opts.triggers?.length
      ? ['triggers:', ...opts.triggers.map((t) => `  - "${t}"`)]
      : []),
    ...(opts.modelHint ? [`model_hint: ${opts.modelHint}`] : []),
    ...(opts.effortHint ? [`effort_hint: ${opts.effortHint}`] : []),
    '---'
  ]

  const list = (items: string[] | undefined, empty: string): string[] =>
    items?.length ? items.map((i) => `- ${i}`) : [empty]

  return [
    ...fm,
    '',
    '## 这个 Skill 做什么',
    '1. 做第一件事',
    '2. 做第二件事',
    '',
    '## 绝对不能做的事（护栏）',
    ...list(opts.forbidden, '- 不做任何事'),
    '',
    '## 需要人工确认的动作',
    ...list(opts.confirm, '（本 skill 无高风险动作，全程只读）'),
    '',
    '## 依赖的 Application',
    ...list(opts.connectors, '（无）'),
    '',
    opts.extra ?? ''
  ].join('\n')
}
