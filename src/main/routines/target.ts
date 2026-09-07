import type { RoutineSkipReason, RoutineTarget, RoutineTargetInput } from '@shared/types'
import type { RiskLevel } from '../gateway/types'

/**
 * The one rule about what a routine may target, shared by the two places that
 * need it: the store, which refuses to save a bad target, and the scheduler,
 * which refuses to fire one.
 *
 * Both, not just the store, because a target that was legal at creation can
 * stop being legal later - the connector manifest is a file the user edits, and
 * raising a tool to write-irreversible must take effect on the next tick rather
 * than at the next restart.
 */

export interface TargetResolvers {
  hasSkill(skillId: string): boolean
  /** undefined when the Gateway does not expose that tool. */
  riskOfTool(qualifiedName: string): RiskLevel | undefined
}

export function checkRoutineTarget(
  target: RoutineTarget | RoutineTargetInput,
  resolvers: TargetResolvers
): RoutineSkipReason | null {
  if (target.kind === 'skill') {
    return resolvers.hasSkill(target.skillId) ? null : 'unknown-skill'
  }

  const risk = resolvers.riskOfTool(target.toolName)
  if (risk === undefined) return 'unknown-tool'

  // A scheduled irreversible action would fire with nobody watching, block on
  // the guardrail, and expire unanswered. Refusing outright is both safer and
  // more honest than a queue of approvals nobody ever saw.
  if (risk === 'write-irreversible') return 'tool-risk-raised'

  return null
}

/** Message for the refusal a user sees when saving, as opposed to a skip. */
export function explainTargetProblem(
  reason: RoutineSkipReason,
  target: RoutineTarget | RoutineTargetInput
): string {
  switch (reason) {
    case 'unknown-skill':
      return `未知 Skill：${target.kind === 'skill' ? target.skillId : '?'}（先运行 skills refresh）`
    case 'unknown-tool':
      return `Gateway 没有这个 tool：${target.kind === 'tool' ? target.toolName : '?'}`
    case 'tool-risk-raised':
      return (
        `${target.kind === 'tool' ? target.toolName : '?'} 是 write-irreversible，` +
        '定时任务不能直接调用不可逆动作——无人值守时它只会阻塞到超时。' +
        '改成写一个 Skill 来做，这样 agent 能在上下文里说明为什么要做，你才好判断是否批准'
      )
    default:
      return reason
  }
}
