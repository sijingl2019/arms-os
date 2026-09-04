import { PlaceholderBody, WidgetFrame } from './WidgetFrame'

/**
 * Calendar and Email have no backend yet - no connector, no credentials, no
 * IPC. They say so rather than showing sample events and sample mail, because a
 * convincing fake is how you end up trusting a panel that was never wired up.
 */

export function CalendarWidget(): React.JSX.Element {
  return (
    <WidgetFrame icon="calendar" title="Calendar">
      <PlaceholderBody note="日历还没有接入。接入方式是给 Gateway 加一个日历 connector，然后这里换成真实日程。" />
    </WidgetFrame>
  )
}

export function EmailWidget(): React.JSX.Element {
  return (
    <WidgetFrame icon="email" title="Email">
      <PlaceholderBody note="邮箱还没有接入。同样走 Gateway connector，凭据由 safeStorage 保管。" />
    </WidgetFrame>
  )
}
