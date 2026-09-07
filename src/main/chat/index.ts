import { randomUUID } from 'node:crypto'
import type { ChatAttachment, ChatMessage, ChatSendResult } from '@shared/types'
import type { nodeSpawner } from '../agents/spawn'
import type { ArmsConfig } from '../config'
import type { ChatBackend, ChatOutcome } from './backend'
import { createClaudeBackend } from './claudeBackend'
import { createCliBackend } from './cliBackend'
import { createCodexBackend } from './codexBackend'

/**
 * The desktop's chat channel: a plain conversation with the agent, with no
 * skill in front of it.
 *
 * Deliberately separate from the Skill Executor. The executor's contract is
 * "run this registered skill and record it as a run"; chat has neither a skill
 * nor anything worth keeping in the runs table, and forcing it through there
 * would mean inventing a fake skill id for every message.
 *
 * The transcript lives here rather than in the renderer so a reopened chat
 * window still shows the conversation, and so the CLI fallback has something to
 * replay.
 */

export interface ChatSession {
  history(): ChatMessage[]
  send(text: string, attachments?: readonly ChatAttachment[]): ChatSendResult
  cancel(): boolean
  clear(): void
  /** True while a reply is being written. */
  busy(): boolean
  /** Which backend answered last, for Settings and for tests. */
  backend(): ChatBackend['kind']
}

export interface ChatDeps {
  config: ArmsConfig
  /** Streams partial output, then the finished (or failed) reply. */
  onChunk(messageId: string, chunk: string): void
  onCompleted(message: ChatMessage): void
  /** Injected so tests can drive a conversation without an agent CLI. */
  spawner?: typeof nodeSpawner
  /** Overrides the default SDK-then-CLI pair; tests use this. */
  backends?: { primary: ChatBackend; fallback: ChatBackend | null }
}

export function createChatSession(deps: ChatDeps): ChatSession {
  const cli = createCliBackend({
    config: deps.config,
    ...(deps.spawner ? { spawner: deps.spawner } : {})
  })
  const sdk =
    deps.config.defaultAgent === 'codex' ? createCodexBackend : createClaudeBackend
  const primary = deps.backends?.primary ?? sdk({ config: deps.config })
  const fallback = deps.backends ? deps.backends.fallback : cli

  const messages: ChatMessage[] = []
  let inFlight: { cancel(): void } | null = null
  let active: ChatBackend = primary
  /**
   * Set when the primary backend fails wordlessly before it has ever worked.
   * That reads as "unusable on this machine" - the SDK missing for this
   * platform, or unauthenticated - and there is no point retrying it on every
   * message. A backend that has answered once is treated as fine: a later
   * wordless failure is transient (a dropped connection, a rate limit), so that
   * message falls back but the session stays on the SDK.
   */
  let primaryUnusable = false
  let primaryEverWorked = false

  const finish = (message: ChatMessage): void => {
    inFlight = null
    deps.onCompleted({ ...message })
  }

  return {
    history: () => messages.map((m) => ({ ...m })),
    busy: () => inFlight !== null,
    backend: () => active.kind,

    clear(): void {
      // Cancelling first, so a reply cannot land in a transcript that was just
      // thrown away.
      inFlight?.cancel()
      inFlight = null
      messages.length = 0
      primary.reset()
      fallback?.reset()
    },

    cancel(): boolean {
      if (!inFlight) return false
      inFlight.cancel()
      return true
    },

    send(text: string, attachments: readonly ChatAttachment[] = []): ChatSendResult {
      const question = text.trim()
      // An attachment with no question is still a message worth sending.
      if (question === '' && attachments.length === 0) return { ok: false, reason: 'empty message' }
      if (inFlight) return { ok: false, reason: 'the agent is still answering' }

      const now = new Date().toISOString()
      const asked: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        text: question,
        at: now,
        status: 'done',
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => ({ ...a })) } : {})
      }
      const reply: ChatMessage = {
        id: randomUUID(),
        role: 'agent',
        text: '',
        at: now,
        status: 'streaming'
      }

      // History as it stood before this exchange: the backend that replays it
      // must not see the empty reply it is about to fill in.
      const history = messages.map((m) => ({ ...m }))
      messages.push(asked, reply)

      const start = (backend: ChatBackend, retryable: boolean): void => {
        active = backend
        let produced = false

        const settle = (outcome: ChatOutcome): void => {
          if (outcome.status === 'done' && backend === primary) primaryEverWorked = true

          // A primary that dies without a word is a broken backend, not a bad
          // answer; hand the same question to the fallback instead of showing
          // the user an error they can do nothing about.
          if (
            retryable &&
            fallback &&
            !produced &&
            outcome.status === 'failed' &&
            backend !== fallback
          ) {
            if (!primaryEverWorked) primaryUnusable = true
            console.warn(`[chat] ${backend.kind} failed silently, falling back to ${fallback.kind}`)
            start(fallback, false)
            return
          }

          reply.status = outcome.status
          reply.text = outcome.text
          finish(reply)
        }

        inFlight = backend.ask({
          question,
          attachments,
          history,
          onChunk(chunk) {
            produced = true
            reply.text += chunk
            deps.onChunk(reply.id, chunk)
          },
          onDone: settle
        })
      }

      const chosen = primaryUnusable && fallback ? fallback : primary
      start(chosen, chosen === primary && fallback !== null)

      return { ok: true, asked: { ...asked }, reply: { ...reply } }
    }
  }
}
