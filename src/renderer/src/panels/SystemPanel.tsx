import type { SystemStatus } from '@shared/types'

interface Props {
  status: SystemStatus | null
  onRefresh(): void
}

/** The `arms doctor` view: where the OS thinks everything lives. */
export function SystemPanel({ status, onRefresh }: Props): React.JSX.Element {
  if (!status) return <p className="empty">Loading…</p>

  const s = status.scheduler

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>System</h3>
        <span className="spacer" />
        <button onClick={onRefresh}>Refresh</button>
      </div>

      <dl className="kv">
        <dt>Workspace</dt>
        <dd className="mono">{status.workspaceRoot}</dd>
        <dt>State dir</dt>
        <dd className="mono">{status.stateDir}</dd>
        <dt>Database</dt>
        <dd className="mono">{status.dbPath}</dd>
        <dt>Run log</dt>
        <dd className="mono">{status.runLogPath}</dd>
        <dt>Default agent</dt>
        <dd>{status.defaultAgent}</dd>
        <dt>Scan roots</dt>
        <dd className="mono">
          {status.scanRoots.map((r) => (
            <div key={r.dir}>
              [{r.source}] {r.dir}
            </div>
          ))}
        </dd>
        <dt>Indexed skills</dt>
        <dd>{status.skillCount}</dd>
        <dt>Routines</dt>
        <dd>{status.routineCount}</dd>
        <dt>Next trigger</dt>
        <dd>{status.nextTriggerAt ? new Date(status.nextTriggerAt).toLocaleString() : '—'}</dd>
        <dt>Interrupted runs</dt>
        <dd>
          {status.interruptedRuns > 0
            ? `${status.interruptedRuns} reconciled from a previous session`
            : 'none'}
        </dd>
        <dt>Scheduler startup</dt>
        <dd>
          {s
            ? `loaded ${s.loaded} · missed ${s.missed} · caught up ${s.caughtUp} · skipped ${s.skipped}`
            : 'not started'}
        </dd>
      </dl>
    </div>
  )
}
