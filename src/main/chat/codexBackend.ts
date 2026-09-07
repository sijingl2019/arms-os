import { Codex, type Thread } from '@openai/codex-sdk'
import type { ArmsConfig } from '../config'
import { attachmentLines, SYSTEM_PREAMBLE, type ChatAsk, type ChatBackend, type ChatTurn } from './backend'

/**
 * Chat through the Codex SDK, the Codex counterpart of `claudeBackend.ts`.
 *
 * Same bargain: the SDK drives the same Codex CLI and the same local
 * credentials, but a `Thread` is a real conversation, so turn two does not
 * replay turn one as one giant argv string.
 *
 * `read-only` + `never` is the Guardrail line: chat may open an attached file,
 * but anything that writes or asks for approval belongs to the Connector
 * Gateway, not here.
 */
export function createCodexBackend(deps: { config: ArmsConfig }): ChatBackend {
  const codex = new Codex()
  let thread: Thread | null = null

  return {
    kind: 'codex-sdk',

    reset(): void {
      thread = null
    },

    ask(ask: ChatAsk): ChatTurn {
      const controller = new AbortController()
      let cancelled = false

      // Codex has no system-prompt option, so the preamble rides the first
      // message of the thread and the thread remembers it from then on.
      const first = thread === null
      thread ??= codex.startThread({
        workingDirectory: deps.config.workspaceRoot,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true
      })

      const prompt = [
        ...(first ? [SYSTEM_PREAMBLE, ''] : []),
        ask.question,
        ...attachmentLines(ask.attachments)
      ].join('\n')

      void (async () => {
        let text = ''
        try {
          const { events } = await thread.runStreamed(prompt, { signal: controller.signal })
          for await (const event of events) {
            if (event.type === 'item.completed' && event.item.type === 'agent_message') {
              text += event.item.text
              ask.onChunk(event.item.text)
            } else if (event.type === 'turn.completed') {
              ask.onDone({ status: 'done', text: text.trim() })
              return
            } else if (event.type === 'turn.failed') {
              ask.onDone({ status: 'failed', text: text.trim() || event.error.message })
              return
            } else if (event.type === 'error') {
              ask.onDone({ status: 'failed', text: text.trim() || event.message })
              return
            }
          }
          ask.onDone({ status: cancelled ? 'cancelled' : 'done', text: text.trim() })
        } catch (err) {
          ask.onDone({
            status: cancelled ? 'cancelled' : 'failed',
            text: text.trim() || (err as Error).message
          })
        }
      })()

      return {
        cancel(): void {
          cancelled = true
          controller.abort()
        }
      }
    }
  }
}
