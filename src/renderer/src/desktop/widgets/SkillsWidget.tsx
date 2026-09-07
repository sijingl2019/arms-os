import { useCallback, useEffect, useState } from 'react'
import type { SkillLintReport, SkillMeta } from '@shared/types'
import { useShell } from '../../i18n/useI18n'
import type { PanelId } from '../../routes'
import { WidgetFrame } from './WidgetFrame'

/** Counts of skills and of the health problems the lint pass found. */
export function SkillsWidget({ onOpen }: { onOpen: (panel: PanelId) => void }): React.JSX.Element {
  const { t } = useShell()
  const [skills, setSkills] = useState<SkillMeta[] | null>(null)
  const [report, setReport] = useState<SkillLintReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void Promise.all([window.arms.skills.list(), window.arms.skills.lint()])
      .then(([list, lint]) => {
        setSkills(list)
        setReport(lint)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
  }, [])

  useEffect(() => {
    load()
    return window.arms.on.skillsIndexed(load)
  }, [load])

  // Warnings are advisory; only errors mean a skill is actually broken.
  const failing = report?.health.filter((h) => h.errors > 0).length ?? 0
  const warned = report?.health.filter((h) => h.errors === 0 && h.warnings > 0).length ?? 0
  const workspace = skills?.filter((s) => s.source === 'workspace').length ?? 0

  const health = (): string => {
    if (!report) return '—'
    if (failing > 0) return t('skills.healthFail', { count: failing })
    if (warned > 0) return t('skills.healthWarn', { count: warned })
    return t('skills.healthPass')
  }

  return (
    <WidgetFrame
      icon="skills"
      titleKey="skills.title"
      ring="skills"
      openPanel="Skills"
      onOpen={onOpen}
      error={error}
    >
      <p className="widget-lede">
        {skills ? t('skills.summary', { total: skills.length, workspace }) : t('common.loading')}
      </p>
      <ul className="widget-list">
        <li>
          <span className={'dot' + (failing > 0 ? ' bad' : warned > 0 ? ' warn' : ' ok')} />
          <span className="grow">{t('skills.health')}</span>
          <span className="muted">{health()}</span>
        </li>
        {(skills ?? []).slice(0, 3).map((s) => (
          <li key={s.id}>
            <span className="grow ellipsis">{s.name}</span>
            <span className="muted">{t('skills.lines', { count: s.lines })}</span>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  )
}
