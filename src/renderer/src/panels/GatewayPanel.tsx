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
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Which credential row has its input open, and what has been typed. */
  const [editing, setEditing] = useState<string | null>(null)
  const [secret, setSecret] = useState('')

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

  async function prune(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await window.arms.gateway.prune()
      // Deleting rows does not shrink the file, so say so rather than let the
      // size on disk look like the pruning did nothing.
      setNotice(
        r.total === 0
          ? '没有过期记录'
          : `清理 ${r.total} 条（${r.aged} 条超期、${r.noise} 条只读噪声）。` +
            '磁盘空间要点「回收空间」才会还给文件系统。'
      )
      load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function compact(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const { before, after } = await window.arms.gateway.compact()
      const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`
      setNotice(`${mb(before)} → ${mb(after)}，回收 ${mb(Math.max(0, before - after))}`)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveSecret(id: string): Promise<void> {
    setError(null)
    try {
      await window.arms.vault.set(id, secret)
      // Drop it from renderer memory the moment it is stored.
      setSecret('')
      setEditing(null)
      setNotice(`已保存 ${id}`)
      await window.arms.gateway.reload()
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function removeSecret(id: string): Promise<void> {
    setError(null)
    try {
      await window.arms.vault.remove(id)
      setNotice(`已删除 ${id}`)
      await window.arms.gateway.reload()
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

      {status && status.credentials.length > 0 && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: '0 0 8px' }}>凭据</h3>
          <p className="status-line" style={{ marginBottom: 10 }}>
            由 OS keychain（safeStorage）加密保管。存进去之后再也读不出来——这里只显示有没有。
          </p>
          {status.credentials.map((cred) => (
            <div className="row" key={cred.id} style={{ marginBottom: 8 }}>
              <span className="mono">{cred.id}</span>
              <span className={cred.present ? 'tag' : 'tag risk'}>
                {cred.present ? '已设置' : '未设置'}
              </span>
              <span className="status-line">{cred.connectorIds.join('、')}</span>
              <span className="spacer" />
              {editing === cred.id ? (
                <>
                  <input
                    type="password"
                    autoFocus
                    value={secret}
                    placeholder="粘贴应用专用密码"
                    onChange={(e) => setSecret(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && secret) void saveSecret(cred.id)
                      if (e.key === 'Escape') {
                        setSecret('')
                        setEditing(null)
                      }
                    }}
                    style={{ minWidth: 220 }}
                  />
                  <button
                    className="primary"
                    disabled={!secret}
                    onClick={() => void saveSecret(cred.id)}
                  >
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setSecret('')
                      setEditing(null)
                    }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setSecret('')
                      setEditing(cred.id)
                    }}
                  >
                    {cred.present ? '替换' : '设置'}
                  </button>
                  {cred.present && (
                    <button className="danger" onClick={() => void removeSecret(cred.id)}>
                      删除
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
          {!status.vault.available && (
            <p className="error">
              当前 vault（{status.vault.kind}）不可写——凭据只能在 ARMS 桌面应用里设置，CLI 不行。
            </p>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {notice && <p className="status-line">{notice}</p>}

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

      <div className="row" style={{ margin: '20px 0 8px' }}>
        <h3 style={{ margin: 0 }}>Recent tool calls</h3>
        {status && (
          <span className="status-line">
            {status.toolCallCount} 条 · 写操作与被拦下的保留 {status.retention.keepDays} 天，
            成功的只读调用保留 {status.retention.keepReadOnlyDays} 天
          </span>
        )}
        <span className="spacer" />
        <button onClick={() => void prune()} disabled={busy}>
          清理过期
        </button>
        <button onClick={() => void compact()} disabled={busy} title="VACUUM，会重写整个数据库文件">
          回收空间
        </button>
      </div>
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
