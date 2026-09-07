import type { AgentId, ChatMessage } from '@shared/types'
import { nodeSpawner } from '../agents/spawn'
import type { CommandLine } from '../agents/types'
import type { ArmsConfig } from '../config'
import { attachmentLines, SYSTEM_PREAMBLE, type ChatAsk, type ChatBackend, type ChatTurn } from './backend'

/**
 * Chat over a headless agent CLI - one process per message.
 *
 * This was the original implementation and is now the fallback: it needs
 * nothing but the CLI on PATH, which makes it the right thing to reach for when
 * the Agent SDK is missing or unauthenticated. Its cost is that the CLI is
 * stateless, so every message replays the transcript.
 */

/** How many turns of history travel with each prompt. */
const HISTORY_TURNS = 12

/**
 * How each CLI takes a bare prompt. This mirrors the runtimes in
 * `src/main/agents/` without going through them, because their `build` needs a
 * SkillMeta and chat has none.
 */
function commandFor(agent: AgentId, prompt: string): CommandLine {
  if (agent === 'codex') return { command: 'codex', args: ['exec', prompt] }
  return { command: 'claude', args: ['-p', prompt] }
}

function buildPrompt(ask: ChatAsk): string {
  const turns = ask.history
    .filter((m) => m.status === 'done' && m.text.trim() !== '')
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)

  return [
    SYSTEM_PREAMBLE,
    '',
    ...turns,
    `User: ${ask.question}`,
    ...attachmentLines(ask.attachments),
    'Assistant:'
  ].join('\n')
}

export interface CliBackendDeps {
  config: ArmsConfig
  /** Injected so tests can drive a conversation without an agent CLI. */
  spawner?: typeof nodeSpawner
}

export function createCliBackend(deps: CliBackendDeps): ChatBackend {
  const spawner = deps.spawner ?? nodeSpawner

  return {
    kind: 'cli',

    // Nothing to forget: each message is its own process, and the transcript
    // this backend replays is owned by the session.
    reset(): void {},

    ask(ask: ChatAsk): ChatTurn {
      const { command, args } = commandFor(deps.config.defaultAgent, buildPrompt(ask))
      let out = ''
      let err = ''

      const handle = spawner(
        {
          command,
          args,
          cwd: deps.config.workspaceRoot,
          timeoutMs: deps.config.defaultTimeoutMs
        },
        {
          onStdout(chunk) {
            out += chunk
            ask.onChunk(chunk)
          },
          onStderr(chunk) {
            // Kept aside rather than shown: agent CLIs write progress noise to
            // stderr, and only a failure makes it worth surfacing.
            err += chunk
          },
          onExit(info) {
            const text = out.trim()
            if (info.reason === 'cancelled') {
              ask.onDone({ status: 'cancelled', text })
            } else if (info.reason === 'exit' && info.code === 0) {
              ask.onDone({ status: 'done', text })
            } else {
              ask.onDone({
                status: 'failed',
                text:
                  text ||
                  err.trim().split('\n').slice(-3).join('\n') ||
                  `${command} exited with ${info.code ?? info.reason}`
              })
            }
          }
        }
      )

      return { cancel: () => handle.cancel() }
    }
  }
}
