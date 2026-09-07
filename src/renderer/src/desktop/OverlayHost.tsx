import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useShell } from '../i18n/useI18n'
import type { MessageKey } from '../i18n/messages'
import type { PanelId } from '../routes'
import { Icon } from './icons'

/**
 * A panel crashing must not take the desktop with it: the boundary sits inside
 * the overlay, so the Dock and the wallpaper behind it stay usable and the user
 * always has a way back.
 */
interface BoundaryProps {
  /** Remount the subtree when the route changes, clearing a previous crash. */
  resetKey: string
  /** Passed in rather than read from context: a class component has no hooks. */
  message(error: Error): string
  hint: string
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
}

class PanelBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  override componentDidUpdate(prev: BoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[panel] render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="empty">
          <p className="error">{this.props.message(this.state.error)}</p>
          <p>{this.props.hint}</p>
        </div>
      )
    }
    return this.props.children
  }
}

export interface OverlayHostProps {
  panel: PanelId
  onClose: () => void
  children: ReactNode
}

export function OverlayHost({ panel, onClose, children }: OverlayHostProps): React.JSX.Element {
  const { t } = useShell()
  const label = t(`panel.${panel}` as MessageKey)

  return (
    <div className="overlay" role="dialog" aria-label={label}>
      <header className="overlay-bar">
        <button type="button" className="ghost" onClick={onClose}>
          <Icon name="home" size={16} />
          {t('overlay.back')}
        </button>
        <h2>{label}</h2>
        <span className="spacer" />
        <span className="status-line">{t('overlay.esc')}</span>
      </header>
      <div className="overlay-body">
        <PanelBoundary
          resetKey={panel}
          message={(error) => t('overlay.crashed', { message: error.message })}
          hint={t('overlay.crashedHint')}
        >
          {children}
        </PanelBoundary>
      </div>
    </div>
  )
}
