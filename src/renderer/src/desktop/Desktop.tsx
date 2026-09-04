import { useState } from 'react'
import type { PanelId } from '../routes'
import { BrainCanvas } from './brain/BrainCanvas'
import { SearchOverlay } from './SearchOverlay'
import { AppsWidget } from './widgets/AppsWidget'
import { GitWidget } from './widgets/GitWidget'
import { CalendarWidget, EmailWidget } from './widgets/PlaceholderWidgets'
import { RoutinesWidget } from './widgets/RoutinesWidget'
import { SkillsWidget } from './widgets/SkillsWidget'

export interface DesktopProps {
  /** True while a panel covers the desktop; the brain stops animating. */
  hidden: boolean
  onOpen: (panel: PanelId) => void
}

/**
 * The home screen: three widgets down each side, the brain in the middle, and
 * the Dock (owned by App) along the bottom.
 */
export function Desktop({ hidden, onOpen }: DesktopProps): React.JSX.Element {
  const [searching, setSearching] = useState(false)

  return (
    <div className="desktop">
      <aside className="widget-column left">
        <AppsWidget onOpen={onOpen} />
        <CalendarWidget />
        <GitWidget />
      </aside>

      <div className="stage">
        <BrainCanvas paused={hidden} dimmed={searching} />
        {!searching && (
          <button
            type="button"
            className="brain-hit"
            aria-label="搜索知识库"
            onClick={() => setSearching(true)}
          >
            <span className="brain-hint">点击搜索知识库</span>
          </button>
        )}
        {searching && (
          <SearchOverlay
            onClose={() => setSearching(false)}
            onOpenMemoryPanel={() => {
              setSearching(false)
              onOpen('Memory')
            }}
          />
        )}
      </div>

      <aside className="widget-column right">
        <EmailWidget />
        <SkillsWidget onOpen={onOpen} />
        <RoutinesWidget onOpen={onOpen} />
      </aside>
    </div>
  )
}
