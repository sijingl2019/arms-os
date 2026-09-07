import { useEffect, useState } from 'react'
import { useShell } from '../i18n/useI18n'
import type { PanelId } from '../routes'
import { BrainCanvas } from './brain/BrainCanvas'
import { Icon } from './icons'
import { SearchOverlay } from './SearchOverlay'
import { AppsWidget } from './widgets/AppsWidget'
import { GitWidget } from './widgets/GitWidget'
import { EmailWidget } from './widgets/EmailWidget'
import { CalendarWidget } from './widgets/PlaceholderWidgets'
import { RoutinesWidget } from './widgets/RoutinesWidget'
import { SkillsWidget } from './widgets/SkillsWidget'

export interface DesktopProps {
  /** True while a panel covers the desktop; the core stops animating. */
  hidden: boolean
  /** The chat window floats over the same space the search box uses. */
  chatOpen: boolean
  onOpen: (panel: PanelId) => void
}

/**
 * The home screen: three widgets down each side, the particle core in the
 * middle, and the Dock (owned by App) along the bottom.
 */
export function Desktop({ hidden, chatOpen, onOpen }: DesktopProps): React.JSX.Element {
  const { t } = useShell()
  const [searching, setSearching] = useState(false)

  // Two floating panels over one stage is a mess; the newer one wins.
  useEffect(() => {
    if (chatOpen) setSearching(false)
  }, [chatOpen])

  return (
    <div className="desktop">
      <aside className="widget-column left">
        <AppsWidget onOpen={onOpen} />
        <CalendarWidget onOpen={onOpen} />
        <GitWidget />
      </aside>

      <div className="stage">
        <BrainCanvas paused={hidden} dimmed={searching} />
        {!searching && (
          <button
            type="button"
            className="core-hit"
            aria-label={t('search.label')}
            onClick={() => setSearching(true)}
          >
            <span className="core-hint"><Icon name="search" size={14} />{t('search.label')}</span>
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
        <EmailWidget onOpen={onOpen} />
        <SkillsWidget onOpen={onOpen} />
        <RoutinesWidget onOpen={onOpen} />
      </aside>
    </div>
  )
}
