import { useEffect, useRef, useState } from 'react'
import type { MemorySearchHit } from '@shared/types'
import { Icon } from './icons'

const DEBOUNCE_MS = 200
const LIMIT = 20

export interface SearchOverlayProps {
  onClose: () => void
  /** Opens the Memory panel when the index turns out to be empty. */
  onOpenMemoryPanel: () => void
}

/**
 * Knowledge-base search, floating over the dimmed brain.
 *
 * Deliberately thin: it searches, it opens a file, and that is all. Anything
 * more (filters, index maintenance, the router files) belongs in the Memory
 * panel, which is one click away.
 */
export function SearchOverlay({
  onClose,
  onOpenMemoryPanel
}: SearchOverlayProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [indexedFiles, setIndexedFiles] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    void window.arms.memory
      .status()
      .then((s) => setIndexedFiles(s.totalFiles))
      .catch(() => setIndexedFiles(null))
  }, [])

  useEffect(() => {
    // Esc closes the search. App's own Esc handler only fires when a panel is
    // open, so the two never fight over the same key.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const q = query.trim()
    if (q === '') {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    // Cleared by the cleanup below, so a slow query that lands after the user
    // has typed on cannot overwrite the newer results.
    let cancelled = false
    // Debounced: FTS over tens of thousands of files should not run per keypress.
    const timer = setTimeout(() => {
      void window.arms.memory
        .search({ query: q, limit: LIMIT })
        .then((results) => {
          if (cancelled) return
          setHits(results)
          setError(null)
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const open = (hit: MemorySearchHit): void => {
    void window.arms.memory.open(hit.path).then((reason) => {
      if (reason) setError(reason)
    })
  }

  return (
    <div
      className="search-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="search-box" role="search">
        <div className="search-field">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索知识库…"
            aria-label="搜索知识库"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="ghost" onClick={onClose} aria-label="关闭搜索">
            <Icon name="close" size={16} />
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {indexedFiles === 0 && (
          <p className="search-note">
            知识库还没有索引任何文件。
            <button type="button" className="linkish" onClick={onOpenMemoryPanel}>
              去 Memory 面板做一次 refresh
            </button>
          </p>
        )}

        {query.trim() !== '' && (
          <ul className="search-results">
            {hits.map((hit) => (
              <li key={hit.path}>
                <button type="button" onClick={() => open(hit)}>
                  <span className="hit-title">{hit.title || hit.name}</span>
                  <span className="hit-path">{hit.relPath}</span>
                  {hit.snippet && <span className="hit-snippet">{hit.snippet}</span>}
                </button>
              </li>
            ))}
            {hits.length === 0 && !searching && <li className="search-note">没有匹配的内容</li>}
          </ul>
        )}
      </div>
    </div>
  )
}
