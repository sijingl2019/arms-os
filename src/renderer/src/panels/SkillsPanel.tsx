import { useCallback, useEffect, useState } from 'react'
import type { RunRecord, SkillMeta } from '@shared/types'

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

  const load = useCallback(() => {
    void window.arms.skills.list().then(setSkills)
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
