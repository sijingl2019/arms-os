import { useCallback, useEffect, useState } from 'react'
import type { RoutineDef, RoutineResult } from '@shared/types'
import type { PanelId } from '../../routes'
import { useShell } from '../../i18n/useI18n'
import { PlaceholderBody, WidgetFrame } from './WidgetFrame'

/**
 * The mailbox glance.
 *
 * It renders whatever a scheduled tool routine last wrote, and never fetches
 * anything itself. That indirection is the point: polling a mailbox is
 * mechanical, so it goes through a Gateway tool on a cron - cheap, deterministic
 * and credential-safe - rather than through an agent, which would cost a full
 * model round trip per refresh.
 */

interface EmailSummary {
  unread: number
  messages: Array<{ uid: number; from: string; subject: string; date: string | null }>
}

/** The connector answers in JSON; anything else means it is not wired up right. */
function parseSummary(raw: string | null): EmailSummary | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const value = parsed as Partial<EmailSummary>
    if (typeof value.unread !== 'number') return null
    return { unread: value.unread, messages: Array.isArray(value.messages) ? value.messages : [] }
  } catch {
    return null
  }
}

/** The routine feeding this widget: any tool routine pointing at the mailbox. */
function findMailRoutine(routines: RoutineDef[]): RoutineDef | undefined {
  return routines.find(
    (r) => r.target.kind === 'tool' && r.target.toolName.startsWith('email.')
  )
}

interface Props {
  onOpen?: (panel: PanelId) => void
}

export function EmailWidget({ onOpen }: Props = {}): React.JSX.Element {
  const { t } = useShell()
  const [routine, setRoutine] = useState<RoutineDef | undefined>()
  const [value, setValue] = useState<RoutineResult | null>(null)

  const load = useCallback(() => {
    void window.arms.routines.list().then((all) => {
      const mail = findMailRoutine(all)
      setRoutine(mail)
      if (!mail) {
        setValue(null)
        return
      }
      void window.arms.routines.result(mail.id).then(setValue)
    })
  }, [])

  useEffect(() => {
    load()
    return window.arms.on.routinesUpdated(load)
  }, [load])

  // No routine yet: this is a configuration state, not an error, and the badge
  // is the way to go fix it.
  if (!routine) {
    return (
      <WidgetFrame
        icon="email"
        titleKey="email.title"
        ring="applications"
        openPanel="Gateway"
        {...(onOpen ? { onOpen } : {})}
      >
        <PlaceholderBody
          note={t('email.note')}
          configurePanel="Gateway"
          {...(onOpen ? { onOpen } : {})}
        />
      </WidgetFrame>
    )
  }

  const summary = parseSummary(value?.result ?? null)
  const failed = value?.status === 'failed'

  return (
    <WidgetFrame
      icon="email"
      titleKey="email.title"
      ring="applications"
      openPanel="Routines"
      {...(onOpen ? { onOpen } : {})}
      {...(failed ? { error: value?.error ?? 'the mailbox check failed' } : {})}
    >
      {summary ? (
        <>
          <div className="row" style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: 18 }}>{summary.unread}</strong>
            <span className="muted">{t('email.unread')}</span>
            <span className="spacer" />
            {value?.updatedAt && (
              <span className="muted" title={new Date(value.updatedAt).toLocaleString()}>
                {new Date(value.updatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          {summary.messages.length === 0 ? (
            <p className="muted">{t('email.allRead')}</p>
          ) : (
            <ul className="plain-list">
              {summary.messages.slice(0, 5).map((m) => (
                <li key={m.uid} title={`${m.from}\n${m.subject}`}>
                  <span className="muted">{m.from.split('<')[0]?.trim() || m.from}</span>{' '}
                  {m.subject}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        // The routine exists but has not produced a readable value yet.
        <p className="muted">{t('email.waiting')}</p>
      )}
    </WidgetFrame>
  )
}
