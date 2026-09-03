import type { AgentRuntime, BuildContext, CommandLine } from './types'

/**
 * Claude Code, invoked headless per 架构规范 §4.4:
 *   claude -p "/news-digest" --model claude-sonnet-5 --effort medium
 *
 * The slash command lets Claude Code load and apply SKILL.md itself, so we do
 * not restate the skill's steps or guardrails in the prompt.
 */
export const claudeRuntime: AgentRuntime = {
  id: 'claude',
  needsSkillBody: false,

  build(ctx: BuildContext): CommandLine {
    const prompt = ctx.args?.trim()
      ? `/${ctx.skill.name} ${ctx.args.trim()}`
      : `/${ctx.skill.name}`

    const args = ['-p', prompt]
    if (ctx.model) args.push('--model', ctx.model)
    if (ctx.effort) args.push('--effort', ctx.effort)

    return { command: 'claude', args }
  }
}
