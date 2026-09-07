import { useCallback, useEffect, useState } from 'react'
import type { RoutineDef } from '@shared/types'
import { useShell } from '../../i18n/useI18n'
import type { PanelId } from '../../routes'
import { WidgetFrame } from './WidgetFrame'

/** Enabled routines and when the next one fires. */
export function RoutinesWidget({
  onOpen
}: {
  onOpen: (panel: PanelId) => void
}): React.JSX.Element {
  const { t } = useShell()
  const [routines, setRoutines] = useState<RoutineDef[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.arms.routines
      .list()
      .then((list) => {
        setRoutines(list)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
  }, [])

  useEffect(() => {
    load()
    // Both a scheduling change and a finished run move `nextRunAt`.
    const offs = [window.arms.on.routinesUpdated(load), window.arms.on.runCompleted(load)]
    return () => offs.forEach((off) => off())
  }, [load])

  const formatNext = (iso: string): string => {
    const at = new Date(iso)
    const minutes = Math.round((at.getTime() - Date.now()) / 60000)
    if (minutes < 1) return t('routines.imminent')
    if (minutes < 60) return t('routines.inMinutes', { count: minutes })
    if (minutes < 60 * 24) return t('routines.inHours', { count: Math.round(minutes / 60) })
    return at.toLocaleDateString()
  }

  const enabled = (routines ?? []).filter((r) => r.enabled)
  const upcoming = enabled
    .filter((r): r is RoutineDef & { nextRunAt: string } => r.nextRunAt !== null)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))

  return (
    <WidgetFrame
      icon="routines"
      titleKey="routines.title"
      ring="routines"
      openPanel="Routines"
      onOpen={onOpen}
      error={error}
    >
      <p className="widget-lede">
        {routines
          ? t('routines.summary', { enabled: enabled.length, total: routines.length })
          : t('common.loading')}
      </p>
      <ul className="widget-list">
        {upcoming.slice(0, 4).map((r) => (
          <li key={r.id}>
            <span className={'dot' + (r.lastStatus === 'failed' ? ' bad' : ' ok')} />
            <span className="grow ellipsis">{r.name}</span>
            <span className="muted">{formatNext(r.nextRunAt)}</span>
          </li>
        ))}
      </ul>
      {routines && upcoming.length === 0 && <p className="widget-hint">{t('routines.none')}</p>}
    </WidgetFrame>
  )
}
