import { useCallback, useEffect, useState } from 'react'
import type { GatewayStatus, PendingConfirmation, ToolCallRecord } from '@shared/types'

const RISK_LABEL: Record<string, string> = {
  'read-only': 'read-only',
  'write-reversible': 'reversible write',
  'write-irreversible': 'IRREVERSIBLE'
}

function riskClass(risk: string): string {
  return risk === 'write-irreversible' ? 'tag risk' : 'tag'
}

/**
 * Connector Gateway 设计文档 §2.3 场景 D.
 *
 * An approval card is not decoration: an agent is blocked on it right now, so
 * the arguments are shown verbatim - what is displayed here is exactly what
 * will be executed.
 */
export function GatewayPanel(): React.JSX.Element {
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [pending, setPending] = useState<PendingConfirmation[]>([])
  const [calls, setCalls] = useState<ToolCallRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void window.arms.gateway.status().then(setStatus)
    void window.arms.confirmations.pending().then(setPending)
    void window.arms.gateway.toolCalls(50).then(setCalls)
  }, [])

  useEffect(() => {
    load()
    const offs = [
      window.arms.on.confirmationPending(load),
      window.arms.on.confirmationDecided(load),
      window.arms.on.toolCalled(load)
    ]
    return () => offs.forEach((off) => off())
  }, [load])

  async function decide(item: PendingConfirmation, approve: boolean): Promise<void> {
    setError(null)
    try {
      if (approve) await window.arms.confirmations.approve(item.confirmationId)
      else await window.arms.confirmations.reject(item.confirmationId, 'rejected from the dashboard')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function reload(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const issues = await window.arms.gateway.reload()
      if (issues.length > 0) setError(issues.join(' · '))
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <h3 style={{ margin: 0 }}>Connector Gateway</h3>
          <span className={status?.running ? 'tag' : 'tag risk'}>
            {status?.running ? 'listening' : 'stopped'}
          </span>
          <span className="spacer" />
          <button onClick={() => void reload()} disabled={busy}>
            {busy ? 'Reloading…' : 'Reload manifest'}
          </button>
        </div>
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Endpoint</dt>
          <dd className="mono">{status?.endpoint ?? '—'}</dd>
          <dt>Manifest</dt>
          <dd className="mono">{status?.manifestPath ?? '—'}</dd>
          <dt>Credentials</dt>
          <dd>
            {status
              ? `${status.vault.kind}${status.vault.available ? '' : ' (unavailable)'}`
              : '—'}
          </dd>
          <dt>Connectors</dt>
          <dd>
            {status && status.connectors.length > 0
              ? status.connectors.map((c) => (
                  <div key={c.id}>
                    {c.id} · {c.transport} · {c.toolCount} tools
                    {c.error ? ` · ${c.error}` : ''}
                  </div>
                ))
              : 'none configured'}
          </dd>
        </dl>
        {status && status.issues.length > 0 && (
          <p className="error">{status.issues.join(' · ')}</p>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <h3 style={{ margin: '16px 0 8px' }}>
        Awaiting your approval {pending.length > 0 && `(${pending.length})`}
      </h3>
      {pending.length === 0 ? (
        <p className="empty">Nothing is waiting on you.</p>
      ) : (
        <div className="grid">
          {pending.map((item) => (
            <article className="card" key={item.confirmationId}>
              <div className="row" style={{ marginBottom: 6 }}>
                <strong className="mono">{item.qualifiedName}</strong>
                <span className={riskClass(item.risk)}>{RISK_LABEL[item.risk] ?? item.risk}</span>
              </div>
              <p style={{ minHeight: 0, marginBottom: 6 }}>
                requested {new Date(item.requestedAt).toLocaleTimeString()} · expires{' '}
                {new Date(item.expiresAt).toLocaleTimeString()}
              </p>
              {/* Verbatim, because this is precisely what will be executed. */}
              <pre className="console mono" style={{ marginTop: 0, maxHeight: 160 }}>
                {JSON.stringify(item.args, null, 2)}
              </pre>
              <div className="row">
                <button className="primary" onClick={() => void decide(item, true)}>
                  Approve
                </button>
                <button className="danger" onClick={() => void decide(item, false)}>
                  Reject
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <h3 style={{ margin: '20px 0 8px' }}>Recent tool calls</h3>
      {calls.length === 0 ? (
        <p className="empty">No connector has been called yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Tool</th>
              <th>Risk</th>
              <th>Outcome</th>
              <th>Took</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => (
              <tr key={call.callId}>
                <td>{new Date(call.startedAt).toLocaleString()}</td>
                <td className="mono">{call.qualifiedName}</td>
                <td>
                  <span className={riskClass(call.risk)}>{RISK_LABEL[call.risk] ?? call.risk}</span>
                </td>
                <td>
                  <span className={`status ${call.outcome === 'succeeded' ? 'succeeded' : 'failed'}`}>
                    {call.outcome}
                  </span>
                </td>
                <td>{call.durationMs === null ? '—' : `${call.durationMs}ms`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
