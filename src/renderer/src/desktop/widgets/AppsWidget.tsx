import { useCallback, useEffect, useState } from 'react'
import type { GatewayStatus } from '@shared/types'
import { useShell } from '../../i18n/useI18n'
import type { PanelId } from '../../routes'
import { WidgetFrame } from './WidgetFrame'

/**
 * "Apps" on this desktop means the connectors the Gateway exposes - those are
 * the hands that actually reach the outside world (CLAUDE.md: Skill is the
 * brain, Connector is the hand).
 */
export function AppsWidget({ onOpen }: { onOpen: (panel: PanelId) => void }): React.JSX.Element {
  const { t } = useShell()
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.arms.gateway
      .status()
      .then((s) => {
        setStatus(s)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
  }, [])

  useEffect(() => {
    load()
    // A tool call is the cheapest signal that a connector's state may have moved.
    return window.arms.on.toolCalled(load)
  }, [load])

  const connectors = status?.connectors ?? []
  const enabled = connectors.filter((c) => c.enabled)

  return (
    <WidgetFrame
      icon="apps"
      titleKey="apps.title"
      ring="applications"
      openPanel="Gateway"
      onOpen={onOpen}
      error={error}
    >
      <p className="widget-lede">
        {status
          ? t('apps.summary', {
              enabled: enabled.length,
              total: connectors.length,
              tools: status.tools.length
            })
          : t('common.loading')}
      </p>
      <ul className="widget-list">
        {connectors.slice(0, 5).map((c) => (
          <li key={c.id}>
            <span className={'dot' + (c.error ? ' bad' : c.enabled ? ' ok' : '')} />
            <span className="grow">{c.id}</span>
            <span className="muted">{c.error ? t('apps.error') : c.toolCount}</span>
          </li>
        ))}
      </ul>
      {status && connectors.length === 0 && <p className="widget-hint">{t('apps.none')}</p>}
      {status && !status.running && <p className="widget-error">{t('apps.endpointDown')}</p>}
    </WidgetFrame>
  )
}
