import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { NewSkillRequest } from '@shared/types'

/**
 * Create a SKILL.md from the 架构规范 §4.1 template.
 *
 * The template ships every guardrail section already present, because a
 * section that has to be remembered is a section that gets skipped - and the
 * lint rules treat a missing 「绝对不能做的事」 as an error precisely because
 * an unguarded skill running unattended is the failure this project exists to
 * prevent.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function validateSkillId(id: string): string | null {
  if (!id.trim()) return 'id 不能为空'
  if (!ID_PATTERN.test(id)) {
    return 'id 只能用小写字母、数字和连字符，且以字母或数字开头'
  }
  return null
}

/**
 * Repair a trigger mangled by a POSIX-emulation shell.
 *
 * Git Bash and MSYS rewrite a leading-slash argument into a Windows path, so
 * `--trigger /publish` arrives as `D:/Softwares/Git/publish`. A slash command
 * is never a filesystem path, so a value that looks like one is recovered
 * rather than written into the file as-is.
 */
export function normaliseTrigger(raw: string): string {
  const value = raw.trim()
  if (!value) return value

  const looksLikePath = /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')
  if (!looksLikePath) return value

  const last = value.split(/[\\/]/).filter(Boolean).pop()
  return last ? `/${last}` : value
}

export function renderSkillTemplate(req: NewSkillRequest): string {
  const supplied = (req.triggers ?? []).map(normaliseTrigger).filter(Boolean)
  const triggers = supplied.length > 0 ? supplied : [`/${req.id}`]

  return [
    '---',
    `name: ${req.id}`,
    `description: ${req.description?.trim() || 'TODO：一句话说明这个 Skill 做什么'}`,
    'triggers:',
    ...triggers.map((t) => `  - "${t}"`),
    `model_hint: ${req.modelHint?.trim() || 'claude-sonnet-5'}`,
    `effort_hint: ${req.effortHint?.trim() || 'medium'}`,
    '---',
    '',
    '## 这个 Skill 做什么',
    '1. TODO：第一步',
    '2. TODO：第二步',
    '',
    '## 绝对不能做的事（护栏）',
    '- TODO：写清楚这个 Skill 永远不该做什么',
    '',
    '## 需要人工确认的动作',
    '（本 skill 无高风险动作，全程只读）',
    '',
    '## 依赖的 Application',
    '（无）',
    ''
  ].join('\n')
}

export interface CreatedSkill {
  id: string
  file: string
}

/**
 * Write the new skill.
 *
 * @throws if the id is malformed or a skill already lives there - silently
 *   overwriting someone's existing SKILL.md would be unforgivable.
 */
export async function createSkill(
  req: NewSkillRequest,
  defaultDir: string
): Promise<CreatedSkill> {
  const problem = validateSkillId(req.id)
  if (problem) throw new Error(problem)

  const dir = path.join(req.destination ?? defaultDir, req.id)
  const file = path.join(dir, 'SKILL.md')

  try {
    await fs.access(file)
    throw new Error(`已存在：${file}`)
  } catch (err) {
    if ((err as Error).message.startsWith('已存在')) throw err
  }

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(file, renderSkillTemplate(req), 'utf8')
  return { id: req.id, file }
}
