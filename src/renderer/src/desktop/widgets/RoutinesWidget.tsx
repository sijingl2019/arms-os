import { useCallback, useEffect, useState } from 'react'
import type { RoutineDef } from '@shared/types'
import type { PanelId } from '../../routes'
import { WidgetFrame } from './WidgetFrame'

function formatNext(iso: string): string {
  const at = new Date(iso)
  const minutes = Math.round((at.getTime() - Date.now()) / 60000)
  if (minutes < 1) return '即将触发'
  if (minutes < 60) return `${minutes} 分钟后`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时后`
  return at.toLocaleDateString()
}

/** Enabled routines and when the next one fires. */
export function RoutinesWidget({
  onOpen
}: {
  onOpen: (panel: PanelId) => void
}): React.JSX.Element {
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

  const enabled = (routines ?? []).filter((r) => r.enabled)
  const upcoming = enabled
    .filter((r): r is RoutineDef & { nextRunAt: string } => r.nextRunAt !== null)
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))

  return (
    <WidgetFrame icon="routines" title="Routines" openPanel="Routines" onOpen={onOpen} error={error}>
      <p className="widget-lede">
        {routines ? `${enabled.length}/${routines.length} 个启用` : '加载中…'}
      </p>
      <ul className="widget-list">
        {upcoming.slice(0, 4).map((r) => (
          <li key={r.id}>
            <span className={'dot' + (r.lastStatus === 'failed' ? ' bad' : ' ok')} />
            <span className="grow ellipsis">{r.name}</span>
            <span className="muted">{formatNext(r.nextRunAt)}</span>
          </li>
        ))}
        {routines && upcoming.length === 0 && <li className="muted">没有已排期的 Routine</li>}
      </ul>
    </WidgetFrame>
  )
}
