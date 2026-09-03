import type { AgentId } from '@shared/types'
import { claudeRuntime } from './claude'
import { codexRuntime } from './codex'
import type { AgentRuntime } from './types'

const RUNTIMES = new Map<AgentId, AgentRuntime>([
  [claudeRuntime.id, claudeRuntime],
  [codexRuntime.id, codexRuntime]
])

export function getRuntime(id: AgentId): AgentRuntime | undefined {
  return RUNTIMES.get(id)
}

export function listRuntimes(): AgentRuntime[] {
  return [...RUNTIMES.values()]
}

export { claudeRuntime, codexRuntime }
