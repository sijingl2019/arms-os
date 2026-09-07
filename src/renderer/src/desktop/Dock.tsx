import { useShell } from '../i18n/useI18n'
import { PANELS, type Route } from '../routes'
import { AppIcon, type AppIconName } from './AppIcon'

export interface DockProps {
  route: Route
  onNavigate: (route: Route) => void
  chatOpen: boolean
  onToggleChat: () => void
  /** Badged onto the Gateway tile; an agent is blocked while it is non-zero. */
  pendingApprovals: number
}

interface DockButtonProps {
  tile: AppIconName
  label: string
  active: boolean
  badge?: number
  onClick: () => void
}

function DockButton({ tile, label, active, badge, onClick }: DockButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={'dock-item' + (active ? ' active' : '')}
      aria-current={active}
      onClick={onClick}
    >
      <AppIcon name={tile} />
      {badge !== undefined && badge > 0 && <span className="dock-badge">{badge}</span>}
      <span className="dock-label">{label}</span>
    </button>
  )
}

/**
 * The Dock: the only always-visible way into the panels, and the way back out
 * of one. Chat is not a panel - it drops out of the Dock as its own window - so
 * it sits with the desktop button rather than with the six panels.
 */
export function Dock({
  route,
  onNavigate,
  chatOpen,
  onToggleChat,
  pendingApprovals
}: DockProps): React.JSX.Element {
  const { t } = useShell()

  return (
    <nav className="dock" aria-label={t('dock.title')}>
      <DockButton
        tile="desktop"
        label={t('dock.home')}
        active={route === null && !chatOpen}
        onClick={() => onNavigate(null)}
      />
      <DockButton
        tile="chat"
        label={t('chat.title')}
        active={chatOpen}
        onClick={onToggleChat}
      />

      <span className="dock-sep" aria-hidden="true" />

      {PANELS.map((panel) => (
        <DockButton
          key={panel.id}
          tile={panel.tile}
          label={t(`panel.${panel.id}`)}
          active={route === panel.id}
          {...(panel.id === 'Gateway' ? { badge: pendingApprovals } : {})}
          // Clicking the panel you are already in takes you back to the desktop.
          onClick={() => onNavigate(route === panel.id ? null : panel.id)}
        />
      ))}
    </nav>
  )
}
