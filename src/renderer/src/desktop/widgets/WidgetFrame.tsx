import type { ReactNode } from 'react'
import { useShell } from '../../i18n/useI18n'
import type { MessageKey } from '../../i18n/messages'
import type { PanelId } from '../../routes'
import { Icon, type IconName } from '../icons'

/** Which ARMS layer a widget belongs to; it colours the dot on its header. */
export type Ring = 'applications' | 'routines' | 'memory' | 'skills'

export interface WidgetFrameProps {
  icon: IconName
  titleKey: MessageKey
  ring: Ring
  /** Rendered as the header shortcut. Omitted when no panel matches. */
  openPanel?: PanelId
  onOpen?: (panel: PanelId) => void
  /** One line under the header; used for errors and load failures. */
  error?: string | null
  /** Optional, because an errored widget renders only its message. */
  children?: ReactNode
}

/**
 * Shared Liquid Glass chrome for the six desktop widgets: a quiet header
 * carrying a layer dot and icon, then a readable content surface.
 *
 * Widgets with no panel behind them (Calendar, Email, Git) pass no `openPanel`
 * and get no shortcut.
 */
export function WidgetFrame({
  icon,
  titleKey,
  ring,
  openPanel,
  onOpen,
  error,
  children
}: WidgetFrameProps): React.JSX.Element {
  const { t } = useShell()

  return (
    <section className="widget glass" data-ring={ring}>
      <header className="widget-head">
        <span className={`ring-dot ring-${ring}`} aria-hidden="true" />
        <Icon name={icon} size={13} />
        <h3>{t(titleKey)}</h3>
        <span className="spacer" />
        {openPanel && onOpen && (
          <button
            type="button"
            className="widget-open"
            title={t('widget.open', { panel: t(`panel.${openPanel}` as MessageKey) })}
            aria-label={t('widget.open', { panel: t(`panel.${openPanel}` as MessageKey) })}
            onClick={() => onOpen(openPanel)}
          >
            <Icon name="open" size={13} />
          </button>
        )}
      </header>
      <div className="widget-body">{error ? <p className="widget-error">{error}</p> : children}</div>
    </section>
  )
}

export interface PlaceholderBodyProps {
  note: string
  /** Where wiring this widget up actually happens. */
  configurePanel?: PanelId
  onOpen?: (panel: PanelId) => void
}

/**
 * A widget with nothing behind it yet. Says so instead of faking data - and,
 * when there is somewhere to go, says so as a button rather than a label: a
 * widget that tells you it is unconfigured and then makes you hunt for the
 * place to configure it is a dead end.
 */
export function PlaceholderBody({
  note,
  configurePanel,
  onOpen
}: PlaceholderBodyProps): React.JSX.Element {
  const { t } = useShell()
  const canConfigure = configurePanel !== undefined && onOpen !== undefined

  return (
    <div className="empty">
      {canConfigure ? (
        <button
          type="button"
          className="pill pill-action"
          onClick={() => onOpen(configurePanel)}
          title={t('widget.configureIn', { panel: t(`panel.${configurePanel}` as MessageKey) })}
        >
          {t('widget.notWired')}
          <Icon name="open" size={10} />
        </button>
      ) : (
        <strong className="pill">{t('widget.notWired')}</strong>
      )}
      <p>{note}</p>
    </div>
  )
}
