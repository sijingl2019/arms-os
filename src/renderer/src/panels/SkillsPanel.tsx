import { useCallback, useEffect, useState } from 'react'
import type { RunRecord, SkillLintReport, SkillMeta } from '@shared/types'

/**
 * The Skills Deck: one card per skill, each a headless trigger
 * (系统设计文档 §6.1 场景 A). Output streams back over `skill:run:chunk`.
 */
export function SkillsPanel(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null)
  const [output, setOutput] = useState('')
  const [finished, setFinished] = useState<string | null>(null)
  const [lint, setLint] = useState<SkillLintReport | null>(null)
  const [showDoctor, setShowDoctor] = useState(false)
  const [newId, setNewId] = useState('')

  const load = useCallback(() => {
    void window.arms.skills.list().then(setSkills)
    void window.arms.skills.lint().then(setLint)
  }, [])

  useEffect(() => {
    load()
    return window.arms.on.skillsIndexed(load)
  }, [load])

  useEffect(() => {
    if (!activeRun) return
    const offChunk = window.arms.on.runChunk((e) => {
      if (e.runId === activeRun.runId) setOutput((prev) => prev + e.chunk)
    })
    const offDone = window.arms.on.runCompleted((e) => {
      if (e.runId !== activeRun.runId) return
      setFinished(e.status)
      setActiveRun(null)
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [activeRun])

  async function refresh(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await window.arms.skills.refresh()
      if (result.warnings.length > 0) setError(result.warnings.slice(0, 3).join(' · '))
    } finally {
      setBusy(false)
    }
  }

  async function run(skill: SkillMeta, dryRun: boolean): Promise<void> {
    setError(null)
    setOutput('')
    setFinished(null)
    try {
      const record = await window.arms.skills.run({
        skillId: skill.id,
        trigger: 'dashboard',
        ...(dryRun ? { dryRun: true } : {})
      })
      if (dryRun) {
        setOutput(`[dry run] ${record.command}\n`)
        setFinished('dry-run')
      } else {
        setActiveRun(record)
        setOutput(`$ ${record.command}\n\n`)
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function createSkill(): Promise<void> {
    setError(null)
    try {
      await window.arms.skills.create({ id: newId.trim() })
      setNewId('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const healthOf = (id: string) => lint?.health.find((h) => h.skillId === id)

  // Only count problems in skills you actually own; third-party plugin skills
  // were never written to this spec and are not yours to fix.
  const ownIds = new Set(skills.filter((s) => s.source === 'workspace').map((s) => s.id))
  const ownErrors =
    lint?.findings.filter((f) => f.severity === 'error' && ownIds.has(f.skillId)).length ?? 0

  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? skills.filter(
        (s) => s.id.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)
      )
    : skills

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <input
          placeholder="Filter skills…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <button onClick={() => void refresh()} disabled={busy}>
          {busy ? 'Rescanning…' : 'Rescan'}
        </button>
        <button onClick={() => void window.arms.skills.writeIndex()}>Write SKILLS_INDEX.md</button>
        <button onClick={() => setShowDoctor((v) => !v)}>
          Doctor
          {ownErrors > 0 && <span className="badge">{ownErrors}</span>}
        </button>
        <input
          placeholder="new-skill-id"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          style={{ width: 150 }}
        />
        <button onClick={() => void createSkill()} disabled={!newId.trim()}>
          New skill
        </button>
        {activeRun && (
          <button className="danger" onClick={() => void window.arms.skills.cancel(activeRun.runId)}>
            Cancel run
          </button>
        )}
        <span className="spacer" />
        <span className="status-line">
          {visible.length} of {skills.length}
        </span>
      </div>

      {error && <p className="error">{error}</p>}

      {showDoctor && lint && <DoctorReport report={lint} skills={skills} />}

      {visible.length === 0 ? (
        <p className="empty">No skills indexed yet. Press Rescan.</p>
      ) : (
        <div className="grid">
          {visible.map((skill) => {
            const risky = skill.guardrails.confirmRequired.length > 0
            return (
              <article className="card" key={skill.id}>
                <h3>{skill.id}</h3>
                <p>{skill.description || <em>no description</em>}</p>
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="tag">{skill.source}</span>
                  {(() => {
                    const h = healthOf(skill.id)
                    if (!h) return null
                    if (h.errors > 0) return <span className="tag risk">{h.errors} 项错误</span>
                    if (h.warnings > 0) return <span className="tag">{h.warnings} 项警告</span>
                    return null
                  })()}
                  {skill.modelHint && <span className="tag">{skill.modelHint}</span>}
                  {skill.effortHint && <span className="tag">{skill.effortHint}</span>}
                  {risky && (
                    <span className="tag risk" title={skill.guardrails.confirmRequired.join('\n')}>
                      {skill.guardrails.confirmRequired.length} need confirmation
                    </span>
                  )}
                </div>
                <div className="row">
                  <button
                    className="primary"
                    disabled={activeRun !== null}
                    onClick={() => void run(skill, false)}
                  >
                    Run
                  </button>
                  <button onClick={() => void run(skill, true)}>Dry run</button>
                  <button onClick={() => void window.arms.skills.reveal(skill.id)}>Reveal</button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {(output || finished) && (
        <div className="console mono">
          {output}
          {finished && `\n[${finished}]`}
        </div>
      )}
    </>
  )
}

const SEVERITY_LABEL: Record<string, string> = {
  error: '错误',
  warning: '警告',
  info: '提示'
}

/**
 * The mechanised form of 架构规范 §11's pre-flight checklist. Errors first:
 * an unguarded skill is the one that matters before the next unattended run.
 */
function DoctorReport({
  report,
  skills
}: {
  report: SkillLintReport
  skills: SkillMeta[]
}): React.JSX.Element {
  const [includeForeign, setIncludeForeign] = useState(false)

  const owned = new Set(skills.filter((s) => s.source === 'workspace').map((s) => s.id))
  const scoped = includeForeign
    ? report.findings
    : report.findings.filter((f) => owned.has(f.skillId))
  const hidden = report.findings.length - scoped.length

  const order = { error: 0, warning: 1, info: 2 } as const
  const sorted = [...scoped].sort((a, b) => order[a.severity] - order[b.severity])

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Skill 体检</h3>
        <span className="tag">{sorted.length} 条</span>
        <label className="status-line" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={includeForeign}
            onChange={(e) => setIncludeForeign(e.target.checked)}
          />
          包含用户级/插件 Skill{hidden > 0 && `（已隐藏 ${hidden} 条）`}
        </label>
        {!report.connectorsChecked && (
          <span className="tag">未配置 connector，已跳过与 Gateway 的一致性校验</span>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="empty">全部通过。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>级别</th>
              <th>Skill</th>
              <th>问题</th>
              <th>怎么办</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((f, i) => (
              <tr key={`${f.skillId}-${f.rule}-${i}`}>
                <td>
                  <span className={`status ${f.severity === 'error' ? 'failed' : ''}`}>
                    {SEVERITY_LABEL[f.severity] ?? f.severity}
                  </span>
                </td>
                <td className="mono">{f.skillId}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>{f.message}</td>
                <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>{f.hint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
