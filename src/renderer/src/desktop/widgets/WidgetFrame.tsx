import type { ReactNode } from 'react'
import type { PanelId } from '../../routes'
import { Icon, type IconName } from '../icons'

export interface WidgetFrameProps {
  icon: IconName
  title: string
  /** Rendered as the top-right shortcut. Omitted when no panel matches. */
  openPanel?: PanelId
  onOpen?: (panel: PanelId) => void
  /** One grey line under the title; used for errors and for load failures. */
  error?: string | null
  /** Optional, because an errored widget renders only its message. */
  children?: ReactNode
}

/**
 * Shared chrome for the six desktop widgets: icon, title, and an optional
 * top-right shortcut into the matching panel. Widgets with no panel behind them
 * (Calendar, Email, Git) simply pass no `openPanel` and get no button.
 */
export function WidgetFrame({
  icon,
  title,
  openPanel,
  onOpen,
  error,
  children
}: WidgetFrameProps): React.JSX.Element {
  return (
    <section className="widget">
      <header className="widget-head">
        <Icon name={icon} size={16} />
        <h3>{title}</h3>
        <span className="spacer" />
        {openPanel && onOpen && (
          <button
            type="button"
            className="ghost icon-only"
            title={`打开 ${openPanel}`}
            aria-label={`打开 ${openPanel}`}
            onClick={() => onOpen(openPanel)}
          >
            <Icon name="open" size={14} />
          </button>
        )}
      </header>
      {error ? <p className="widget-error">{error}</p> : children}
    </section>
  )
}

/** A widget with nothing behind it yet. Says so instead of faking data. */
export function PlaceholderBody({ note }: { note: string }): React.JSX.Element {
  return (
    <div className="widget-placeholder">
      <span className="tag">未接入</span>
      <p>{note}</p>
    </div>
  )
}
