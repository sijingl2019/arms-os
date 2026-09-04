import { useCallback, useEffect, useState } from 'react'
import type { RunRecord } from '@shared/types'

function duration(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`
}

/** Run history straight off the `runs` table - the audit trail, not a cache. */
export function RunsPanel(): React.JSX.Element {
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [selected, setSelected] = useState<RunRecord | null>(null)

  const load = useCallback(() => {
    void window.arms.runs.history({ limit: 100 }).then(setRuns)
  }, [])

  useEffect(() => {
    load()
    const offs = [window.arms.on.runCompleted(load), window.arms.on.runStarted(load)]
    return () => offs.forEach((off) => off())
  }, [load])

  if (runs.length === 0) return <p className="empty">No runs recorded yet.</p>

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Skill</th>
            <th>Trigger</th>
            <th>Agent</th>
            <th>Exit</th>
            <th>Took</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.runId}
              onClick={() => setSelected(run)}
              style={{ cursor: 'pointer' }}
              title="Show output"
            >
              <td>{new Date(run.startedAt).toLocaleString()}</td>
              <td>
                <span className={`status ${run.status}`}>{run.status}</span>
              </td>
              <td className="mono">{run.skillId ?? '(raw)'}</td>
              <td>{run.routineId ? `routine` : run.trigger}</td>
              <td>
                {run.agent}
                {run.model ? ` / ${run.model}` : ''}
              </td>
              <td>{run.exitCode ?? '—'}</td>
              <td>{duration(run.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <div className="console mono">
          <div style={{ color: 'var(--muted)' }}>$ {selected.command}</div>
          {'\n'}
          {selected.output || '(no output captured)'}
          {selected.error ? `\n\nerror: ${selected.error}` : ''}
        </div>
      )}
    </>
  )
}
