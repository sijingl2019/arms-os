import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MemoryIndexProgress,
  MemoryIndexStatus,
  MemorySearchHit
} from '@shared/types'

/**
 * Knowledge-base search and index control (系统设计文档 §6.3).
 *
 * Search runs against SQLite FTS5 in the main process; the renderer never sees
 * the index itself, which is what keeps retrieval flat as the vault grows.
 */
export function MemoryPanel(): React.JSX.Element {
  const [status, setStatus] = useState<MemoryIndexStatus | null>(null)
  const [progress, setProgress] = useState<MemoryIndexProgress | null>(null)
  const [query, setQuery] = useState('')
  const [area, setArea] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [error, setError] = useState<string | null>(null)
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
          // Ignore a stale response so fast typing cannot show old results.
          if (seq === searchSeq.current) setHits(results)
        })
    }, 120)
    return () => clearTimeout(timer)
  }, [query, area])

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

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <h3 style={{ margin: 0 }}>Second Brain</h3>
          <span className="tag">{status ? `${status.totalFiles} files` : '—'}</span>
          <span className="spacer" />
          <button onClick={() => void reindex(false, false)} disabled={busy}>
            {busy ? 'Indexing…' : 'Reindex'}
          </button>
          <button onClick={() => void reindex(true, false)} disabled={busy}>
            Full rebuild
          </button>
          <button onClick={() => void reindex(false, true)} disabled={busy}>
            Write router files
          </button>
        </div>

        {progress && (
          <p className="status-line" style={{ marginTop: 8 }}>
            {progress.phase} · {progress.seen} seen · {progress.changed} changed
            {progress.currentRoot ? ` · ${progress.currentRoot}` : ''}
          </p>
        )}

        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Roots</dt>
          <dd className="mono">
            {roots.length > 0 ? roots.map((r) => <div key={r}>{r}</div>) : '未配置（ARMS_MEMORY_ROOTS）'}
          </dd>
          <dt>Router root</dt>
          <dd className="mono">{status?.routerRoot ?? '—'}</dd>
          <dt>Last indexed</dt>
          <dd>{status?.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : '—'}</dd>
          {status?.lastResult && (
            <>
              <dt>Last sweep</dt>
              <dd>
                +{status.lastResult.added} ~{status.lastResult.updated} -{status.lastResult.removed}{' '}
                · {status.lastResult.unchanged} unchanged · {status.lastResult.durationMs}ms
              </dd>
            </>
          )}
        </dl>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          placeholder="搜索知识库…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
        />
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">所有领域</option>
          {status?.areas.map((a) => (
            <option key={a.area} value={a.area}>
              {a.area || '(根目录)'} ({a.files})
            </option>
          ))}
        </select>
      </div>

      {query.trim() && hits.length === 0 ? (
        <p className="empty">没有匹配。少于三个字的查询只能按文件名和标题匹配。</p>
      ) : hits.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>标题</th>
              <th>领域</th>
              <th>路径</th>
              <th>匹配片段</th>
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
          {roots.length === 0
            ? '先配置 ARMS_MEMORY_ROOTS，再点 Reindex。'
            : '输入关键词开始搜索。'}
        </p>
      )}
    </>
  )
}
