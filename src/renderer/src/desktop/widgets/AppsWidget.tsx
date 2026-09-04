import { useCallback, useEffect, useState } from 'react'
import type { GatewayStatus } from '@shared/types'
import type { PanelId } from '../../routes'
import { WidgetFrame } from './WidgetFrame'

/**
 * "Apps" on this desktop means the connectors the Gateway exposes - those are
 * the hands that actually reach the outside world (CLAUDE.md: Skill 是大脑,
 * Connector 是手).
 */
export function AppsWidget({ onOpen }: { onOpen: (panel: PanelId) => void }): React.JSX.Element {
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
    <WidgetFrame icon="apps" title="Apps" openPanel="Gateway" onOpen={onOpen} error={error}>
      <p className="widget-lede">
        {status
          ? `${enabled.length}/${connectors.length} 个 connector · ${status.tools.length} 个 tool`
          : '加载中…'}
      </p>
      <ul className="widget-list">
        {connectors.slice(0, 5).map((c) => (
          <li key={c.id}>
            <span className={'dot' + (c.error ? ' bad' : c.enabled ? ' ok' : '')} />
            <span className="grow">{c.id}</span>
            <span className="muted">{c.error ? '错误' : `${c.toolCount}`}</span>
          </li>
        ))}
        {status && connectors.length === 0 && <li className="muted">manifest 里还没有 connector</li>}
      </ul>
      {status && !status.running && <p className="widget-error">MCP 端点未监听</p>}
    </WidgetFrame>
  )
}
