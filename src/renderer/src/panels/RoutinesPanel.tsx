import { useCallback, useEffect, useState } from 'react'
import type {
  GatewayToolInfo,
  MissedRunPolicy,
  RoutineDef,
  RoutineTargetInput,
  SkillMeta
} from '@shared/types'

const BLANK = {
  name: '',
  targetKind: 'skill' as 'skill' | 'tool',
  skillId: '',
  toolName: '',
  cron: '0 9 * * *',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  args: '',
  missedRunPolicy: 'skip' as MissedRunPolicy,
  maxRetries: 0
}

function describeTarget(r: RoutineDef): string {
  return r.target.kind === 'tool' ? r.target.toolName : r.target.skillId
}

/** A tool target takes a JSON object; anything unparseable becomes no arguments. */
function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

/**
 * Routine management. The "仅在本应用运行时触发" caveat from the old MVP is
 * gone: the scheduler now lives in a tray-resident main process, and Export
 * hands the schedule to the OS for the cases where even that is not enough.
 */
export function RoutinesPanel(): React.JSX.Element {
  const [routines, setRoutines] = useState<RoutineDef[]>([])
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [tools, setTools] = useState<GatewayToolInfo[]>([])
  const [draft, setDraft] = useState({ ...BLANK })
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.arms.routines.list().then(setRoutines)
  }, [])

  useEffect(() => {
    load()
    void window.arms.skills.list().then(setSkills)
    // Only tools a schedule may actually reach: an irreversible action cannot
    // be answered by a cron at 3am, so the main process refuses it anyway.
    void window.arms.gateway
      .status()
      .then((s) => setTools(s.tools.filter((t) => t.risk !== 'write-irreversible')))
    return window.arms.on.routinesUpdated(load)
  }, [load])

  async function create(): Promise<void> {
    setError(null)
    try {
      const target: RoutineTargetInput =
        draft.targetKind === 'tool'
          ? { kind: 'tool', toolName: draft.toolName, toolArgs: parseToolArgs(draft.args) }
          : { kind: 'skill', skillId: draft.skillId, args: draft.args || null }

      await window.arms.routines.create({
        name: draft.name,
        target,
        cron: draft.cron,
        timezone: draft.timezone || null,
        missedRunPolicy: draft.missedRunPolicy,
        maxRetries: Number(draft.maxRetries)
      })
      setDraft({ ...BLANK })
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function patch(id: string, change: Parameters<typeof window.arms.routines.update>[1]) {
    setError(null)
    try {
      await window.arms.routines.update(id, change)
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function exportTask(id: string): Promise<void> {
    setError(null)
    setExported(null)
    try {
      const plan = await window.arms.routines.exportSystemTask(id)
      setExported(
        plan.command
          ? [...plan.notes.map((n) => `# ${n}`), plan.command].join('\n')
          : `# cannot express this routine as a ${plan.platform} task\n` +
              plan.notes.map((n) => `# ${n}`).join('\n')
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <div className="form">
        <div className="field">
          <label htmlFor="r-name">Name</label>
          <input
            id="r-name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="r-kind">目标类型</label>
          <select
            id="r-kind"
            value={draft.targetKind}
            onChange={(e) =>
              setDraft({ ...draft, targetKind: e.target.value as 'skill' | 'tool', args: '' })
            }
          >
            <option value="skill">Skill（会调用 agent）</option>
            <option value="tool">Gateway tool（直连，不花 agent）</option>
          </select>
        </div>
        {draft.targetKind === 'skill' ? (
          <div className="field">
            <label htmlFor="r-skill">Skill</label>
            <select
              id="r-skill"
              value={draft.skillId}
              onChange={(e) => setDraft({ ...draft, skillId: e.target.value })}
            >
              <option value="">choose…</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="r-tool">Tool</label>
            <select
              id="r-tool"
              value={draft.toolName}
              onChange={(e) => setDraft({ ...draft, toolName: e.target.value })}
            >
              <option value="">choose…</option>
              {tools.map((t) => (
                <option key={t.qualifiedName} value={t.qualifiedName}>
                  {t.qualifiedName} [{t.risk}]
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="r-cron">Cron</label>
          <input
            id="r-cron"
            className="mono"
            value={draft.cron}
            onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="r-tz">Timezone</label>
          <input
            id="r-tz"
            value={draft.timezone}
            onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="r-args">
            {draft.targetKind === 'tool' ? 'Args（JSON）' : 'Args'}
          </label>
          <input
            id="r-args"
            value={draft.args}
            onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="r-missed">Missed trigger</label>
          <select
            id="r-missed"
            value={draft.missedRunPolicy}
            onChange={(e) =>
              setDraft({ ...draft, missedRunPolicy: e.target.value as MissedRunPolicy })
            }
          >
            <option value="skip">skip</option>
            <option value="catch-up-once">catch up once</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-retries">Retries</label>
          <input
            id="r-retries"
            type="number"
            min={0}
            value={draft.maxRetries}
            onChange={(e) => setDraft({ ...draft, maxRetries: Number(e.target.value) })}
          />
        </div>
        <button
          className="primary"
          onClick={() => void create()}
          disabled={draft.targetKind === 'skill' ? !draft.skillId : !draft.toolName}
        >
          Add routine
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {routines.length === 0 ? (
        <p className="empty">No routines yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>On</th>
              <th>Name</th>
              <th>Skill</th>
              <th>Cron</th>
              <th>Timezone</th>
              <th>Next run</th>
              <th>Last</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {routines.map((r) => (
              <tr key={r.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    aria-label={`enable ${r.name}`}
                    onChange={(e) => void patch(r.id, { enabled: e.target.checked })}
                  />
                </td>
                <td>{r.name}</td>
                <td className="mono">
                  {r.target.kind === 'tool' && <span className="tag">tool</span>} {describeTarget(r)}
                </td>
                <td className="mono">{r.cron}</td>
                <td>{r.timezone ?? 'local'}</td>
                <td>{when(r.nextRunAt)}</td>
                <td>
                  <span className={`status ${r.lastStatus ?? ''}`}>{r.lastStatus ?? '—'}</span>
                </td>
                <td>
                  <div className="row">
                    <button onClick={() => void exportTask(r.id)}>Export</button>
                    <button className="danger" onClick={() => void window.arms.routines.remove(r.id).then(load)}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {exported && <pre className="console mono">{exported}</pre>}
    </>
  )
}
