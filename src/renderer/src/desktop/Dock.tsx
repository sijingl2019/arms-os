import { PANELS, type Route } from '../routes'
import { Icon } from './icons'

export interface DockProps {
  route: Route
  onNavigate: (route: Route) => void
  /** Badged onto the Gateway icon; an agent is blocked while it is non-zero. */
  pendingApprovals: number
}

/**
 * The Dock: the only always-visible way into the six panels. It stays on top of
 * an open panel, so it doubles as the way back out.
 */
export function Dock({ route, onNavigate, pendingApprovals }: DockProps): React.JSX.Element {
  return (
    <nav className="dock" aria-label="应用坞">
      <button
        type="button"
        className={'dock-item' + (route === null ? ' active' : '')}
        aria-current={route === null}
        onClick={() => onNavigate(null)}
      >
        <Icon name="home" size={22} />
        <span className="dock-label">桌面</span>
      </button>

      <span className="dock-sep" aria-hidden="true" />

      {PANELS.map((panel) => (
        <button
          key={panel.id}
          type="button"
          className={'dock-item' + (route === panel.id ? ' active' : '')}
          aria-current={route === panel.id}
          // Clicking the panel you are already in takes you back to the desktop.
          onClick={() => onNavigate(route === panel.id ? null : panel.id)}
        >
          <Icon name={panel.icon} size={22} />
          {panel.id === 'Gateway' && pendingApprovals > 0 && (
            <span className="dock-badge">{pendingApprovals}</span>
          )}
          <span className="dock-label">{panel.label}</span>
        </button>
      ))}
    </nav>
  )
}
