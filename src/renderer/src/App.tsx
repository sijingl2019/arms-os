import { useCallback, useEffect, useState } from 'react'
import type { SystemStatus } from '@shared/types'
import { RoutinesPanel } from './panels/RoutinesPanel'
import { RunsPanel } from './panels/RunsPanel'
import { SkillsPanel } from './panels/SkillsPanel'
import { SystemPanel } from './panels/SystemPanel'

const TABS = ['Skills', 'Routines', 'Runs', 'System'] as const
type Tab = (typeof TABS)[number]

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('Skills')
  const [status, setStatus] = useState<SystemStatus | null>(null)

  const refreshStatus = useCallback(() => {
    void window.arms.system.status().then(setStatus)
  }, [])

  useEffect(() => {
    refreshStatus()
    // Anything that changes counts should refresh the header line.
    const offs = [
      window.arms.on.skillsIndexed(refreshStatus),
      window.arms.on.routinesUpdated(refreshStatus),
      window.arms.on.runCompleted(refreshStatus)
    ]
    return () => offs.forEach((off) => off())
  }, [refreshStatus])

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">ARMS Agentic OS</span>
        <nav className="tabs" role="tablist">
          {TABS.map((name) => (
            <button
              key={name}
              className="tab"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="status-line">
          {status
            ? `${status.skillCount} skills · ${status.routineCount} routines` +
              (status.nextTriggerAt
                ? ` · next ${new Date(status.nextTriggerAt).toLocaleString()}`
                : '')
            : 'loading…'}
        </span>
      </header>

      <main className="body">
        {tab === 'Skills' && <SkillsPanel />}
        {tab === 'Routines' && <RoutinesPanel />}
        {tab === 'Runs' && <RunsPanel />}
        {tab === 'System' && <SystemPanel status={status} onRefresh={refreshStatus} />}
      </main>
    </div>
  )
}
