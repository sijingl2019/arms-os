import { useCallback, useEffect, useState } from 'react'
import type { GitStatus } from '@shared/types'
import { useShell } from '../../i18n/useI18n'
import { WidgetFrame } from './WidgetFrame'

/**
 * Read-only view of the workspace repository. There is no panel behind it, so
 * it carries no shortcut - and no write actions, which is why it never touches
 * the Gateway's Guardrail.
 */
export function GitWidget(): React.JSX.Element {
  const { t } = useShell()
  const [status, setStatus] = useState<GitStatus | null>(null)

  const load = useCallback(() => {
    void window.arms.git.status().then(setStatus)
  }, [])

  useEffect(() => {
    load()
    // Git has no event to subscribe to, and the user usually commits in another
    // window, so re-read whenever they come back to this one.
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])

  if (status && !status.isRepo) {
    return (
      <WidgetFrame
        icon="git"
        titleKey="git.title"
        ring="skills"
        error={status.error ?? t('git.notRepo')}
      />
    )
  }

  const dirty = status ? status.staged + status.unstaged + status.untracked : 0

  return (
    <WidgetFrame icon="git" titleKey="git.title" ring="skills">
      <p className="widget-lede">
        {status ? (
          <>
            <span className="branch">{status.branch ?? t('git.detached')}</span>
            {status.ahead > 0 && <span className="muted"> ↑{status.ahead}</span>}
            {status.behind > 0 && <span className="muted"> ↓{status.behind}</span>}
            <span className="muted">
              {' · '}
              {dirty === 0 ? t('git.clean') : t('git.dirty', { count: dirty })}
            </span>
          </>
        ) : (
          t('common.loading')
        )}
      </p>
      <ul className="widget-list">
        {(status?.commits ?? []).slice(0, 4).map((c) => (
          <li key={c.hash}>
            <span className="mono muted">{c.hash}</span>
            <span className="grow ellipsis">{c.subject}</span>
          </li>
        ))}
      </ul>
      {status && status.commits.length === 0 && <p className="widget-hint">{t('git.noCommits')}</p>}
    </WidgetFrame>
  )
}
