import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryIndexProgress, MemoryIndexStatus, MemorySearchHit } from '@shared/types'
import { useShell } from '../i18n/useI18n'

/**
 * Knowledge-base search and index control (系统设计文档 §6.3).
 *
 * Search runs against SQLite FTS5 in the main process; the renderer never sees
 * the index itself, which is what keeps retrieval flat as the vault grows.
 *
 * Roots are chosen here rather than only through `ARMS_MEMORY_ROOTS`, because a
 * panel that tells you it is unconfigured and then names an environment
 * variable is a dead end for anyone not running from a shell.
 */
export function MemoryPanel(): React.JSX.Element {
  const { t } = useShell()
  const [status, setStatus] = useState<MemoryIndexStatus | null>(null)
  const [progress, setProgress] = useState<MemoryIndexProgress | null>(null)
  const [query, setQuery] = useState('')
  const [area, setArea] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Guards against an older search resolving after a newer one. */
  const searchSeq = useRef(0)

  const loadStatus = useCallback(() => {
    void window.arms.memory.status().then(setStatus)
  }, [])

  useEffect(() => {
    loadStatus()
    const offs = [
      window.arms.on.memoryProgress(setProgress),
      window.arms.on.memoryCompleted(() => {
        setProgress(null)
        loadStatus()
      })
    ]
    return () => offs.forEach((off) => off())
  }, [loadStatus])

  useEffect(() => {
    const needle = query.trim()
    if (!needle) {
      setHits([])
      return
    }
    const seq = ++searchSeq.current
    const timer = setTimeout(() => {
      void window.arms.memory
        .search({ query: needle, ...(area ? { area } : {}), limit: 50 })
        .then((results) => {
          if (seq === searchSeq.current) setHits(results)
        })
    }, 120)
    return () => clearTimeout(timer)
  }, [query, area])

  async function addRoot(): Promise<void> {
    setError(null)
    setNotice(null)
    try {
      const chosen = await window.arms.memory.chooseRoot()
      if (!chosen) return
      const current = status?.roots ?? []
      if (current.includes(chosen)) return
      await window.arms.memory.setRoots([...current, chosen])
      loadStatus()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function removeRoot(root: string): Promise<void> {
    setError(null)
    setNotice(null)
    try {
      const next = (status?.roots ?? []).filter((r) => r !== root)
      const result = await window.arms.memory.setRoots(next)
      // Say how many rows went with it - a silent removal looks like a no-op.
      setNotice(t('memory.removed', { path: root, n: result.pruned }))
      loadStatus()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function reindex(force: boolean, writeRouter: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await window.arms.memory.refresh({ force, writeRouter })
      if (result.warnings.length > 0) setError(result.warnings.slice(0, 3).join(' · '))
      loadStatus()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const roots = status?.roots ?? []
  const hasRoots = roots.length > 0

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <h3 style={{ margin: 0 }}>{t('memory.title')}</h3>
          <span className="tag">{t('memory.files', { n: status?.totalFiles ?? 0 })}</span>
          <span className="spacer" />
          <button onClick={() => void reindex(false, false)} disabled={busy || !hasRoots}>
            {busy ? t('memory.indexing') : t('memory.reindex')}
          </button>
          <button onClick={() => void reindex(true, false)} disabled={busy || !hasRoots}>
            {t('memory.fullRebuild')}
          </button>
          <button onClick={() => void reindex(false, true)} disabled={busy || !hasRoots}>
            {t('memory.writeRouter')}
          </button>
        </div>

        {progress && (
          <p className="status-line" style={{ marginTop: 8 }}>
            {progress.phase} · {progress.seen} · {progress.changed}
            {progress.currentRoot ? ` · ${progress.currentRoot}` : ''}
          </p>
        )}

        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>{t('memory.roots')}</dt>
          <dd>
            {hasRoots ? (
              roots.map((root) => (
                <div className="row" key={root} style={{ gap: 8, marginBottom: 4 }}>
                  <span className="mono">{root}</span>
                  <button className="danger" onClick={() => void removeRoot(root)}>
                    {t('memory.removeRoot')}
                  </button>
                </div>
              ))
            ) : (
              <span className="muted">{t('memory.noRoots')}</span>
            )}
            <div style={{ marginTop: 6 }}>
              <button className="primary" onClick={() => void addRoot()}>
                {t('memory.addRoot')}
              </button>
            </div>
          </dd>
          <dt>{t('memory.routerRoot')}</dt>
          <dd className="mono">{status?.routerRoot ?? '—'}</dd>
          <dt>{t('memory.lastIndexed')}</dt>
          <dd>{status?.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : '—'}</dd>
          {status?.lastResult && (
            <>
              <dt>{t('memory.lastSweep')}</dt>
              <dd>
                +{status.lastResult.added} ~{status.lastResult.updated} -{status.lastResult.removed}{' '}
                · {status.lastResult.unchanged} · {status.lastResult.durationMs}ms
              </dd>
            </>
          )}
        </dl>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="status-line">{notice}</p>}

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          placeholder={t('memory.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
        />
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">{t('memory.allAreas')}</option>
          {status?.areas.map((a) => (
            <option key={a.area} value={a.area}>
              {a.area || t('memory.rootArea')} ({a.files})
            </option>
          ))}
        </select>
      </div>

      {query.trim() && hits.length === 0 ? (
        <p className="empty">{t('memory.noMatch')}</p>
      ) : hits.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{t('memory.colTitle')}</th>
              <th>{t('memory.colArea')}</th>
              <th>{t('memory.colPath')}</th>
              <th>{t('memory.colSnippet')}</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((hit) => (
              <tr key={hit.path}>
                <td>{hit.title || hit.name}</td>
                <td>{hit.area || '—'}</td>
                <td className="mono" style={{ maxWidth: 280, overflow: 'hidden' }}>
                  {hit.relPath}
                </td>
                <td style={{ whiteSpace: 'normal', maxWidth: 380 }}>{hit.snippet || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty">
          {hasRoots ? t('memory.emptyReady') : t('memory.emptyNoRoots')}
        </p>
      )}
    </>
  )
}
