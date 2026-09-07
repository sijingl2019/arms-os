import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAttachment, ChatMessage } from '@shared/types'
import { useShell } from '../i18n/useI18n'
import { Icon } from './icons'

/**
 * The conversation panel that drops out of the Dock.
 *
 * It talks to the agent through `chat:*`, which keeps the transcript in the
 * main process - so this component can be unmounted and remounted (the Dock
 * toggles it) without losing the conversation.
 */
export interface ChatDockProps {
  onClose: () => void
}

/** Bytes as something a person reads at a glance. */
function formatSize(bytes: number): string {
  if (bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function ChatDock({ onClose }: ChatDockProps): React.JSX.Element {
  const { t } = useShell()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<ChatAttachment[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  const busy = messages.at(-1)?.status === 'streaming'

  useEffect(() => {
    inputRef.current?.focus()
    void window.arms.chat.history().then(setMessages)

    const offs = [
      window.arms.on.chatChunk(({ messageId, chunk }) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, text: m.text + chunk } : m))
        )
      }),
      window.arms.on.chatCompleted((done) => {
        setMessages((prev) => prev.map((m) => (m.id === done.id ? done : m)))
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    /**
     * Clicking anywhere else puts the window away, the way a Dock popover
     * should. The Dock itself is excluded: its chat tile toggles this panel, and
     * closing here first would make that click reopen what it just closed.
     */
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if ((target as Element).closest?.('.dock')) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  // Follow the tail while the agent writes, the way a chat window should.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages])

  const attach = useCallback(() => {
    void window.arms.chat.pickFiles().then((picked) => {
      if (picked.length === 0) return
      // Picking the same file twice should not queue it twice.
      setPending((prev) => {
        const seen = new Set(prev.map((a) => a.path))
        return [...prev, ...picked.filter((a) => !seen.has(a.path))]
      })
      inputRef.current?.focus()
    })
  }, [])

  const send = useCallback(() => {
    const text = draft.trim()
    if (text === '' && pending.length === 0) return
    setNotice(null)
    void window.arms.chat.send(text, pending).then((result) => {
      if (!result.ok) {
        setNotice(result.reason)
        return
      }
      setDraft('')
      setPending([])
      setMessages((prev) => [...prev, result.asked, result.reply])
    })
  }, [draft, pending])

  const clear = useCallback(() => {
    void window.arms.chat.clear().then(() => {
      setMessages([])
      setNotice(null)
    })
  }, [])

  return (
    <section className="chat-dock glass" aria-label={t('chat.title')} ref={panelRef}>
      <header className="chat-head">
        <h2>{t('chat.title')}</h2>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-glyph"
          title={t('chat.clear')}
          aria-label={t('chat.clear')}
          onClick={clear}
          disabled={messages.length === 0}
        >
          <Icon name="trash" size={13} />
        </button>
        <button
          type="button"
          className="btn btn-glyph"
          title={t('common.close')}
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      <div className="chat-log" ref={listRef}>
        {messages.length === 0 && <p className="chat-empty label">{t('chat.empty')}</p>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-row chat-${m.role}`}>
            <div className={`chat-bubble${m.status === 'failed' ? ' failed' : ''}`}>
              {m.attachments && m.attachments.length > 0 && (
                <ul className="chat-files">
                  {m.attachments.map((a) => (
                    <li key={a.path} title={a.path}>
                      <Icon name="paperclip" size={11} />
                      <span className="ellipsis">{a.name}</span>
                    </li>
                  ))}
                </ul>
              )}
              {m.text || (m.status === 'streaming' ? t('chat.thinking') : '')}
            </div>
          </div>
        ))}
      </div>

      {notice && <p className="chat-notice">{notice}</p>}

      {pending.length > 0 && (
        <ul className="chat-pending">
          {pending.map((a) => (
            <li key={a.path} title={a.path}>
              <Icon name="paperclip" size={11} />
              <span className="ellipsis">{a.name}</span>
              <span className="muted">{formatSize(a.size)}</span>
              <button
                type="button"
                className="chip-x"
                aria-label={t('chat.removeFile', { name: a.name })}
                onClick={() => setPending((prev) => prev.filter((f) => f.path !== a.path))}
              >
                <Icon name="close" size={10} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="chat-input">
        <button
          type="button"
          className="btn btn-glyph"
          title={t('chat.attach')}
          aria-label={t('chat.attach')}
          onClick={attach}
        >
          <Icon name="paperclip" size={14} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder={t('chat.placeholder')}
          aria-label={t('chat.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line - the chat convention.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            className="chat-send stop"
            title={t('chat.stop')}
            aria-label={t('chat.stop')}
            onClick={() => void window.arms.chat.cancel()}
          >
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="chat-send"
            title={t('chat.send')}
            aria-label={t('chat.send')}
            onClick={send}
            disabled={draft.trim() === '' && pending.length === 0}
          >
            <Icon name="send" size={14} />
          </button>
        )}
      </div>
    </section>
  )
}
