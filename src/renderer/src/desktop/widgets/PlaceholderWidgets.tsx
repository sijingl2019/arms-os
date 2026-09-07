import type { PanelId } from '../../routes'
import { useShell } from '../../i18n/useI18n'
import { PlaceholderBody, WidgetFrame } from './WidgetFrame'

/**
 * Calendar and Email have no backend yet - no connector, no credentials, no
 * IPC. They say so rather than showing sample events and sample mail, because a
 * convincing fake is how you end up trusting a panel that was never wired up.
 *
 * Both are wired up the same way, by adding a connector, so both send you to
 * the Gateway panel rather than leaving you to find it.
 */

interface PlaceholderProps {
  onOpen?: (panel: PanelId) => void
}

export function CalendarWidget({ onOpen }: PlaceholderProps = {}): React.JSX.Element {
  const { t } = useShell()
  return (
    <WidgetFrame
      icon="calendar"
      titleKey="calendar.title"
      ring="routines"
      openPanel="Gateway"
      {...(onOpen ? { onOpen } : {})}
    >
      <PlaceholderBody
        note={t('calendar.note')}
        configurePanel="Gateway"
        {...(onOpen ? { onOpen } : {})}
      />
    </WidgetFrame>
  )
}
