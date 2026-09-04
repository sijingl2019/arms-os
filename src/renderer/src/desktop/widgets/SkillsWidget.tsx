import { useCallback, useEffect, useState } from 'react'
import type { SkillLintReport, SkillMeta } from '@shared/types'
import type { PanelId } from '../../routes'
import { WidgetFrame } from './WidgetFrame'

/** Counts of skills and of the health problems the lint pass found. */
export function SkillsWidget({ onOpen }: { onOpen: (panel: PanelId) => void }): React.JSX.Element {
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

  return (
    <WidgetFrame icon="skills" title="Skills" openPanel="Skills" onOpen={onOpen} error={error}>
      <p className="widget-lede">
        {skills ? `${skills.length} 个 Skill · 工作区 ${workspace} 个` : '加载中…'}
      </p>
      <ul className="widget-list">
        <li>
          <span className={'dot' + (failing > 0 ? ' bad' : warned > 0 ? ' warn' : ' ok')} />
          <span className="grow">体检</span>
          <span className="muted">
            {report
              ? failing > 0
                ? `${failing} 个不通过`
                : warned > 0
                  ? `${warned} 个有提醒`
                  : '全部通过'
              : '—'}
          </span>
        </li>
        {(skills ?? []).slice(0, 3).map((s) => (
          <li key={s.id}>
            <span className="grow ellipsis">{s.name}</span>
            <span className="muted">{s.lines} 行</span>
          </li>
        ))}
      </ul>
    </WidgetFrame>
  )
}
