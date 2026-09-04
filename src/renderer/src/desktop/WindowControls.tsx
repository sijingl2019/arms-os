import { useEffect, useState } from 'react'
import { Icon } from './icons'

/**
 * Replacement for the native title bar, which `frame: false` took away.
 *
 * The drag strip is a sibling of these buttons rather than their parent: an
 * `-webkit-app-region: drag` region swallows clicks, so anything interactive
 * has to opt back out, and keeping the two separate makes that impossible to
 * get wrong by nesting.
 */
export function WindowControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    // The window can also be maximized by a system gesture - double-clicking
    // the drag strip, Win+Up, edge snap - so follow the window, not our clicks.
    return window.arms.on.windowMaximized(setMaximized)
  }, [])

  return (
    <div className="window-controls">
      <button
        type="button"
        className="win-btn"
        title="最小化"
        aria-label="最小化"
        onClick={() => void window.arms.window.minimize()}
      >
        <Icon name="minimize" size={14} />
      </button>
      <button
        type="button"
        className="win-btn"
        title={maximized ? '还原' : '最大化'}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void window.arms.window.maximize().then(setMaximized)}
      >
        <Icon name={maximized ? 'restore' : 'maximize'} size={14} />
      </button>
      <button
        type="button"
        className="win-btn danger"
        // Closing hides to the tray; the scheduler keeps running. Quitting is
        // deliberately only available from the tray menu.
        title="隐藏到托盘"
        aria-label="隐藏到托盘"
        onClick={() => void window.arms.window.close()}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
