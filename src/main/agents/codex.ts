import type { AgentRuntime, BuildContext, CommandLine } from './types'

/**
 * Codex CLI has no slash-command mechanism, so the skill body is inlined into
 * the prompt. This is the one place where the two runtimes genuinely differ;
 * keeping it here is what lets the executor deal only in skill ids.
 */
export const codexRuntime: AgentRuntime = {
  id: 'codex',
  needsSkillBody: true,

  build(ctx: BuildContext): CommandLine {
    const body = ctx.skillBody?.trim()
    if (!body) {
      throw new Error(`codex runtime needs the body of SKILL.md for "${ctx.skill.id}"`)
    }

    const sections = [
      `Follow this skill definition exactly. Its guardrail sections are binding.`,
      '',
      `--- BEGIN ${ctx.skill.name} SKILL.md ---`,
      body,
      `--- END ${ctx.skill.name} SKILL.md ---`
    ]
    if (ctx.args?.trim()) sections.push('', `Arguments: ${ctx.args.trim()}`)

    const args = ['exec', sections.join('\n')]
    if (ctx.model) args.push('--model', ctx.model)

    return { command: 'codex', args }
  }
}
