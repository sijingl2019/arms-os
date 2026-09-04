import { Component, type ErrorInfo, type ReactNode } from 'react'
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
          <p className="error">这个面板渲染失败：{this.state.error.message}</p>
          <p>其余部分仍可使用，按 Esc 返回桌面。</p>
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
  return (
    <div className="overlay" role="dialog" aria-label={panel}>
      <header className="overlay-bar">
        <button type="button" className="ghost" onClick={onClose}>
          <Icon name="home" size={16} />
          返回桌面
        </button>
        <h2>{panel}</h2>
        <span className="spacer" />
        <span className="status-line">Esc 返回</span>
      </header>
      <div className="overlay-body">
        <PanelBoundary resetKey={panel}>{children}</PanelBoundary>
      </div>
    </div>
  )
}
