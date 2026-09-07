import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ArmsConfig } from '../config'
import { attachmentLines, SYSTEM_PREAMBLE, type ChatAsk, type ChatBackend, type ChatTurn } from './backend'

/**
 * Chat through the Claude Agent SDK - Claude Code as a library.
 *
 * This is not "embedding the model in the app": the SDK drives the same Claude
 * Code harness and the same credentials the CLI uses. What it buys over
 * spawning `claude -p` per message is a real session (the transcript stays on
 * the agent's side instead of being replayed as one giant argv string), a
 * structured message stream, and a clean abort.
 *
 * Tools are read-only on purpose. Chat must not become an unsupervised write
 * path: every action that touches the outside world goes through the Connector
 * Gateway, which is the single interception point for anything risky
 * (CLAUDE.md, 系统分层). Reading is allowed so an attached file can be opened.
 */

/** Enough turns to read a couple of attached files and answer. */
const MAX_TURNS = 6

/** Reading is what attachments need; nothing here may write or reach the network. */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep']
const WITHHELD_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task'
]

export interface ClaudeBackendDeps {
  config: ArmsConfig
  /** Injected by tests; defaults to the SDK's own `query`. */
  runQuery?: typeof query
}

/** Pull the readable text out of one streamed message, if it carries any. */
function textOf(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  const blocks = message.message.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('')
}

export function createClaudeBackend(deps: ClaudeBackendDeps): ChatBackend {
  const run = deps.runQuery ?? query
  /** Set from the first reply; every later turn resumes it instead of replaying. */
  let sessionId: string | null = null

  return {
    kind: 'claude-sdk',

    reset(): void {
      sessionId = null
    },

    ask(ask: ChatAsk): ChatTurn {
      const abortController = new AbortController()
      let cancelled = false

      const options: Options = {
        cwd: deps.config.workspaceRoot,
        // A plain string keeps the minimal prompt: this is a conversation, not
        // a coding agent, so the `claude_code` preset would be the wrong voice.
        systemPrompt: SYSTEM_PREAMBLE,
        permissionMode: 'default',
        allowedTools: READ_ONLY_TOOLS,
        disallowedTools: WITHHELD_TOOLS,
        maxTurns: MAX_TURNS,
        abortController,
        ...(sessionId ? { resume: sessionId } : {})
      }

      const prompt = [ask.question, ...attachmentLines(ask.attachments)].join('\n')

      void (async () => {
        let text = ''
        try {
          for await (const message of run({ prompt, options })) {
            // Every frame carries the session id; the first one is what later
            // turns resume, so take it as soon as it appears.
            if ('session_id' in message && message.session_id) sessionId = message.session_id

            const chunk = textOf(message)
            if (chunk !== '') {
              text += chunk
              ask.onChunk(chunk)
            }

            if (message.type === 'result') {
              if (message.subtype === 'success' && !message.is_error) {
                // `result` is the final answer; prefer it over the streamed
                // concatenation, which can include intermediate turns.
                ask.onDone({ status: 'done', text: message.result.trim() || text.trim() })
              } else {
                ask.onDone({
                  status: 'failed',
                  text: text.trim() || `the agent stopped: ${message.subtype}`
                })
              }
              return
            }
          }
          // The stream ended without a result frame - treat whatever arrived as
          // the answer rather than losing it.
          ask.onDone({ status: cancelled ? 'cancelled' : 'done', text: text.trim() })
        } catch (err) {
          if (cancelled) {
            ask.onDone({ status: 'cancelled', text: text.trim() })
            return
          }
          ask.onDone({ status: 'failed', text: text.trim() || (err as Error).message })
        }
      })()

      return {
        cancel(): void {
          cancelled = true
          abortController.abort()
        }
      }
    }
  }
}
