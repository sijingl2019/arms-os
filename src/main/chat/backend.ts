import type { ChatAttachment, ChatMessage } from '@shared/types'

/**
 * What the chat session needs from whatever is actually talking to the agent.
 *
 * Two implementations exist: the Claude Agent SDK (`claudeBackend.ts`) and a
 * headless CLI subprocess (`cliBackend.ts`). The session picks the SDK and
 * falls back to the CLI, so a machine without the SDK - or without the auth it
 * needs - still has a working chat.
 */

export type ChatOutcomeStatus = 'done' | 'failed' | 'cancelled'

export interface ChatOutcome {
  status: ChatOutcomeStatus
  /** The reply as it should be stored. Empty is allowed on a failure. */
  text: string
}

export interface ChatAsk {
  question: string
  attachments: readonly ChatAttachment[]
  /**
   * Prior turns, oldest first. A backend that keeps its own session (the SDK)
   * ignores this; one that spawns a fresh process per message (the CLI) has to
   * replay it.
   */
  history: readonly ChatMessage[]
  onChunk(chunk: string): void
  onDone(outcome: ChatOutcome): void
}

/** A reply in flight. */
export interface ChatTurn {
  cancel(): void
}

export interface ChatBackend {
  /** Shown nowhere; used in logs and in the fallback decision. */
  readonly kind: 'claude-sdk' | 'codex-sdk' | 'cli'
  ask(ask: ChatAsk): ChatTurn
  /** Forget any conversation state, so a cleared transcript really starts over. */
  reset(): void
}

/** Prepended so the agent answers as this OS rather than as a bare CLI. */
export const SYSTEM_PREAMBLE =
  'You are the assistant inside ARMS Agentic OS, a personal agent operating system. ' +
  'Answer conversationally and concisely.'

/**
 * Attachments travel as paths, not contents: the agent has its own file tools,
 * and inlining a 12 MB file into a prompt would fail long before the model saw
 * it.
 */
export function attachmentLines(attachments: readonly ChatAttachment[]): string[] {
  if (attachments.length === 0) return []
  return ['', 'Attached files (read them from disk):', ...attachments.map((a) => `- ${a.path}`)]
}
