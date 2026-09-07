import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '@main/config'
import { createChatSession } from '@main/chat'
import type { ChatAsk, ChatBackend, ChatOutcome } from '@main/chat/backend'
import type { ChatMessage } from '@shared/types'

/**
 * The chat session's own logic: transcript, refusals, and the SDK-to-CLI
 * fallback. Both real backends spawn something, so every test here drives fake
 * ones - what is under test is the decision, not the agent.
 */

interface Fake extends ChatBackend {
  /** The asks this backend received, so a test can settle them by hand. */
  asks: ChatAsk[]
  resets: number
}

function fakeBackend(kind: ChatBackend['kind']): Fake {
  const asks: ChatAsk[] = []
  const fake: Fake = {
    kind,
    asks,
    resets: 0,
    reset() {
      fake.resets += 1
    },
    ask(ask) {
      asks.push(ask)
      return { cancel: () => ask.onDone({ status: 'cancelled', text: '' }) }
    }
  }
  return fake
}

function settle(backend: Fake, outcome: ChatOutcome, index = backend.asks.length - 1): void {
  backend.asks[index]?.onDone(outcome)
}

function session(primary: Fake, fallback: Fake | null = null) {
  const completed: ChatMessage[] = []
  const chunks: Array<{ id: string; chunk: string }> = []
  const chat = createChatSession({
    config: loadConfig(),
    onChunk: (id, chunk) => chunks.push({ id, chunk }),
    onCompleted: (m) => completed.push(m),
    backends: { primary, fallback }
  })
  return { chat, completed, chunks }
}

describe('chat session', () => {
  it('picks the SDK that matches the configured agent', () => {
    const seen: string[] = []
    for (const defaultAgent of ['claude', 'codex'] as const) {
      const chat = createChatSession({
        config: { ...loadConfig(), defaultAgent },
        onChunk: () => {},
        onCompleted: () => {}
      })
      seen.push(chat.backend())
    }
    expect(seen).toEqual(['claude-sdk', 'codex-sdk'])
  })

  it('sends through the primary backend and records both turns', () => {
    const primary = fakeBackend('claude-sdk')
    const { chat, completed } = session(primary)

    const result = chat.send('hello')
    expect(result.ok).toBe(true)
    expect(primary.asks).toHaveLength(1)
    expect(primary.asks[0]?.question).toBe('hello')
    expect(chat.busy()).toBe(true)

    settle(primary, { status: 'done', text: 'hi there' })
    expect(chat.busy()).toBe(false)
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ role: 'agent', status: 'done', text: 'hi there' })

    const history = chat.history()
    expect(history.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(history[0]?.text).toBe('hello')
  })

  it('streams chunks onto the reply as they arrive', () => {
    const primary = fakeBackend('claude-sdk')
    const { chat, chunks } = session(primary)
    chat.send('hi')

    primary.asks[0]?.onChunk('one ')
    primary.asks[0]?.onChunk('two')
    expect(chunks.map((c) => c.chunk)).toEqual(['one ', 'two'])
    expect(chat.history().at(-1)?.text).toBe('one two')
  })

  it('refuses an empty message and a second message while one is in flight', () => {
    const primary = fakeBackend('claude-sdk')
    const { chat } = session(primary)

    expect(chat.send('   ')).toEqual({ ok: false, reason: 'empty message' })

    chat.send('first')
    const second = chat.send('second')
    expect(second).toEqual({ ok: false, reason: 'the agent is still answering' })
    expect(primary.asks).toHaveLength(1)
  })

  it('accepts an attachment with no text, and records it on the user message', () => {
    const primary = fakeBackend('claude-sdk')
    const { chat } = session(primary)

    const file = { path: '/tmp/report.pdf', name: 'report.pdf', size: 42 }
    expect(chat.send('', [file]).ok).toBe(true)
    expect(primary.asks[0]?.attachments).toEqual([file])
    expect(chat.history()[0]?.attachments).toEqual([file])
  })

  it('replays prior turns to the backend, but never the reply being written', () => {
    const primary = fakeBackend('claude-sdk')
    const { chat } = session(primary)

    chat.send('first')
    settle(primary, { status: 'done', text: 'answer' })
    chat.send('second')

    expect(primary.asks[1]?.history.map((m) => m.text)).toEqual(['first', 'answer'])
  })

  describe('fallback', () => {
    it('hands the question to the fallback when the primary fails wordlessly', () => {
      const primary = fakeBackend('claude-sdk')
      const cli = fakeBackend('cli')
      const { chat, completed } = session(primary, cli)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      chat.send('hello')
      settle(primary, { status: 'failed', text: '' })

      expect(cli.asks).toHaveLength(1)
      expect(cli.asks[0]?.question).toBe('hello')
      expect(completed).toHaveLength(0)

      settle(cli, { status: 'done', text: 'from the cli' })
      expect(completed[0]?.text).toBe('from the cli')
      expect(chat.backend()).toBe('cli')
      warn.mockRestore()
    })

    it('stays on the fallback once the primary has never worked', () => {
      const primary = fakeBackend('claude-sdk')
      const cli = fakeBackend('cli')
      const { chat } = session(primary, cli)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      chat.send('one')
      settle(primary, { status: 'failed', text: '' })
      settle(cli, { status: 'done', text: 'ok' })

      chat.send('two')
      expect(primary.asks).toHaveLength(1) // not retried
      expect(cli.asks).toHaveLength(2)
      warn.mockRestore()
    })

    it('keeps using a primary that has already worked, even after a later failure', () => {
      const primary = fakeBackend('claude-sdk')
      const cli = fakeBackend('cli')
      const { chat } = session(primary, cli)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      chat.send('one')
      settle(primary, { status: 'done', text: 'fine' })

      // A wordless failure now is transient - this message falls back, but the
      // session must not be downgraded for good.
      chat.send('two')
      settle(primary, { status: 'failed', text: '' })
      settle(cli, { status: 'done', text: 'rescued' })

      chat.send('three')
      expect(primary.asks).toHaveLength(3)
      warn.mockRestore()
    })

    it('does not fall back when the primary produced output before failing', () => {
      const primary = fakeBackend('claude-sdk')
      const cli = fakeBackend('cli')
      const { chat, completed } = session(primary, cli)

      chat.send('hello')
      primary.asks[0]?.onChunk('half an answer')
      settle(primary, { status: 'failed', text: 'half an answer' })

      expect(cli.asks).toHaveLength(0)
      expect(completed[0]).toMatchObject({ status: 'failed', text: 'half an answer' })
    })

    it('reports a failure as-is when there is no fallback', () => {
      const primary = fakeBackend('claude-sdk')
      const { chat, completed } = session(primary, null)

      chat.send('hello')
      settle(primary, { status: 'failed', text: 'boom' })
      expect(completed[0]).toMatchObject({ status: 'failed', text: 'boom' })
    })
  })

  it('cancel stops the reply in flight and reports nothing to cancel otherwise', () => {
    const primary = fakeBackend('claude-sdk')
    const { chat, completed } = session(primary)

    expect(chat.cancel()).toBe(false)
    chat.send('hello')
    expect(chat.cancel()).toBe(true)
    expect(completed[0]?.status).toBe('cancelled')
  })

  it('clear empties the transcript and resets every backend', () => {
    const primary = fakeBackend('claude-sdk')
    const cli = fakeBackend('cli')
    const { chat } = session(primary, cli)

    chat.send('hello')
    settle(primary, { status: 'done', text: 'hi' })
    chat.clear()

    expect(chat.history()).toEqual([])
    expect(primary.resets).toBe(1)
    expect(cli.resets).toBe(1)
  })
})
