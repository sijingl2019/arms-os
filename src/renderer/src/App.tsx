import { useCallback, useEffect, useState } from 'react'
import { Desktop } from './desktop/Desktop'
import { Dock } from './desktop/Dock'
import { OverlayHost } from './desktop/OverlayHost'
import { WindowControls } from './desktop/WindowControls'
import { GatewayPanel } from './panels/GatewayPanel'
import { MemoryPanel } from './panels/MemoryPanel'
import { RoutinesPanel } from './panels/RoutinesPanel'
import { RunsPanel } from './panels/RunsPanel'
import { SettingsPanel } from './panels/SettingsPanel'
import { SkillsPanel } from './panels/SkillsPanel'
import type { PanelId, Route } from './routes'

/**
 * The shell: a desktop, an optional panel laid over it, and a Dock that is
 * always on top of both. The Dock is what makes the overlay escapable, so it is
 * owned here rather than by either of the two views.
 */
export function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>(null)
  const [pendingApprovals, setPendingApprovals] = useState(0)

  const refreshApprovals = useCallback(() => {
    void window.arms.confirmations.pending().then((p) => setPendingApprovals(p.length))
  }, [])

  useEffect(() => {
    refreshApprovals()
    // The Dock's Gateway badge is the only shell-level state; each panel and
    // widget subscribes to whatever else it needs.
    const offs = [
      window.arms.on.confirmationPending(refreshApprovals),
      window.arms.on.confirmationDecided(refreshApprovals)
    ]
    return () => offs.forEach((off) => off())
  }, [refreshApprovals])

  useEffect(() => {
    if (route === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setRoute(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [route])

  // A waiting approval blocks an agent, so jump straight to it - the same
  // reasoning that makes the main process un-hide the window.
  useEffect(() => window.arms.on.confirmationPending(() => setRoute('Gateway')), [])

  const open = useCallback((panel: PanelId) => setRoute(panel), [])

  return (
    <div className="app">
      {/* No native title bar, so this strip is what the window is dragged by. */}
      <div className="drag-strip" />
      <WindowControls />

      <Desktop hidden={route !== null} onOpen={open} />

      {route !== null && (
        <OverlayHost panel={route} onClose={() => setRoute(null)}>
          {route === 'Skills' && <SkillsPanel />}
          {route === 'Routines' && <RoutinesPanel />}
          {route === 'Runs' && <RunsPanel />}
          {route === 'Memory' && <MemoryPanel />}
          {route === 'Gateway' && <GatewayPanel />}
          {route === 'Settings' && <SettingsPanel />}
        </OverlayHost>
      )}

      <Dock route={route} onNavigate={setRoute} pendingApprovals={pendingApprovals} />
    </div>
  )
}
