import { useCallback, useEffect, useState } from 'react'
import type { AgentInfo, SystemStatus } from '@shared/types'
import { WallpaperSettings } from '../wallpaper/WallpaperSettings'
import { LOCALES, type MessageKey } from '../i18n/messages'
import { useShell, type Theme } from '../i18n/useI18n'

/**
 * Settings, laid out like the earlier MVP's: a category rail on the left, one
 * panel on the right.
 *
 * Connectors and the knowledge base are not here on purpose - they already have
 * their own Dock panels, and a second copy of the same controls is how the two
 * drift apart. What is left is what has nowhere else to live.
 *
 * Most of it is read-only, and says so. ARMS builds its configuration from
 * defaults and environment variables (`src/main/config.ts`) with no writable
 * store yet, so the honest thing is to show the live value next to the variable
 * that changes it, rather than a control that silently does nothing.
 */

const CATEGORIES = [
  { id: 'general', labelKey: 'settings.general', hintKey: 'settings.generalHint' },
  { id: 'wallpaper', labelKey: 'settings.wallpaper', hintKey: 'settings.wallpaperHint' },
  { id: 'agents', labelKey: 'settings.agents', hintKey: 'settings.agentsHint' }
] as const satisfies ReadonlyArray<{ id: string; labelKey: MessageKey; hintKey: MessageKey }>

type Category = (typeof CATEGORIES)[number]['id']

const THEMES: readonly Theme[] = ['dark', 'light']

export function SettingsPanel(): React.JSX.Element {
  const { t } = useShell()
  const [category, setCategory] = useState<Category>('general')

  return (
    <div className="settings-split">
      <nav className="settings-nav" aria-label={t('settings.categories')}>
        {CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={'settings-nav-item' + (category === entry.id ? ' on' : '')}
            aria-current={category === entry.id}
            onClick={() => setCategory(entry.id)}
          >
            <strong>{t(entry.labelKey)}</strong>
            <span className="settings-nav-hint">{t(entry.hintKey)}</span>
          </button>
        ))}
      </nav>

      <div className="settings-panel">
        {category === 'general' && <GeneralSettings />}
        {category === 'wallpaper' && <WallpaperSettings />}
        {category === 'agents' && <AgentSettings />}
      </div>
    </div>
  )
}

/** A read-only value plus the environment variable that changes it. */
function EnvNote({ name }: { name: string }): React.JSX.Element {
  return <span className="pill mono">{name}</span>
}

/* ----------------------------------------------------------------- general */

function GeneralSettings(): React.JSX.Element {
  const { t, locale, setLocale, theme, setTheme } = useShell()
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.arms.system.status().then(setStatus)
  }, [])

  useEffect(load, [load])

  return (
    <>
      <h2 className="settings-h">{t('settings.general')}</h2>

      <section>
        <span className="label">{t('settings.appearance')}</span>
        <p className="settings-note">{t('settings.appearanceNote')}</p>
        <div className="settings-row">
          <span className="settings-row-label">{t('settings.language')}</span>
          <div className="seg">
            {LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                className={'seg-btn' + (locale === option ? ' on' : '')}
                onClick={() => setLocale(option)}
              >
                {option === 'zh' ? '中文' : 'English'}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">{t('settings.theme')}</span>
          <div className="seg">
            {THEMES.map((option) => (
              <button
                key={option}
                type="button"
                className={'seg-btn' + (theme === option ? ' on' : '')}
                onClick={() => setTheme(option)}
              >
                {t(option === 'dark' ? 'settings.themeDark' : 'settings.themeLight')}
              </button>
            ))}
          </div>
        </div>
      </section>

      {status === null ? (
        <p className="empty">{t('common.loading')}</p>
      ) : (
        <>
          <section>
            <span className="label">{t('settings.paths')}</span>
            <p className="settings-note">{t('settings.readOnly')}</p>
            <dl className="kv">
              <dt>
                {t('settings.workspace')} <EnvNote name="ARMS_WORKSPACE" />
              </dt>
              <dd className="mono">{status.workspaceRoot}</dd>
              <dt>
                {t('settings.stateDir')} <EnvNote name="ARMS_STATE_DIR" />
              </dt>
              <dd className="mono">{status.stateDir}</dd>
              <dt>{t('settings.database')}</dt>
              <dd className="mono">{status.dbPath}</dd>
              <dt>{t('settings.runLog')}</dt>
              <dd className="mono">{status.runLogPath}</dd>
              <dt>{t('settings.scanRoots')}</dt>
              <dd className="mono">
                {status.scanRoots.map((r) => (
                  <div key={r.dir}>
                    [{r.source}] {r.dir}
                  </div>
                ))}
              </dd>
            </dl>
          </section>

          <section>
            <span className="label">{t('settings.runtime')}</span>
            <dl className="kv">
              <dt>{t('settings.indexedSkills')}</dt>
              <dd>{status.skillCount}</dd>
              <dt>{t('settings.routines')}</dt>
              <dd>{status.routineCount}</dd>
              <dt>{t('settings.nextTrigger')}</dt>
              <dd>
                {status.nextTriggerAt ? new Date(status.nextTriggerAt).toLocaleString() : '—'}
              </dd>
              <dt>{t('settings.interrupted')}</dt>
              <dd>
                {status.interruptedRuns > 0
                  ? t('settings.interruptedCount', { count: status.interruptedRuns })
                  : t('common.none')}
              </dd>
              <dt>{t('settings.schedulerBoot')}</dt>
              <dd>
                {status.scheduler
                  ? t('settings.schedulerLine', {
                      loaded: status.scheduler.loaded,
                      missed: status.scheduler.missed,
                      caughtUp: status.scheduler.caughtUp,
                      skipped: status.scheduler.skipped
                    })
                  : t('settings.schedulerOff')}
              </dd>
            </dl>
          </section>

          <section>
            <span className="label">{t('settings.maintenance')}</span>
            <div className="row">
              <button className="btn" onClick={load}>
                {t('common.refresh')}
              </button>
              <button
                className="btn"
                onClick={() => {
                  void window.arms.skills
                    .refresh()
                    .then((r) =>
                      setNote(
                        t('settings.rescanDone', {
                          added: r.added,
                          updated: r.updated,
                          removed: r.removed
                        })
                      )
                    )
                }}
              >
                {t('settings.rescan')}
              </button>
              <button
                className="btn"
                onClick={() => {
                  void window.arms.skills
                    .writeIndex()
                    .then((file) => setNote(t('settings.written', { file })))
                }}
              >
                {t('settings.writeIndex')}
              </button>
            </div>
            {note && <p className="settings-note">{note}</p>}
          </section>
        </>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ agents */

function AgentSettings(): React.JSX.Element {
  const { t } = useShell()
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)

  const load = useCallback(() => {
    setAgents(null)
    void window.arms.agents.list().then(setAgents)
  }, [])

  useEffect(load, [load])

  return (
    <>
      <h2 className="settings-h">{t('settings.agents')}</h2>
      <p className="settings-note">{t('settings.agentsNote')}</p>

      <section>
        <div className="row">
          <span className="label">{t('settings.installedClis')}</span>
          <span className="spacer" />
          <button className="btn" onClick={load} disabled={agents === null}>
            {agents === null ? t('settings.probing') : t('settings.reprobe')}
          </button>
        </div>
        <ul className="agent-list">
          {(agents ?? []).map((agent) => (
            <li key={agent.id}>
              <span className={'dot' + (agent.available ? ' ok' : ' bad')} />
              <span className="grow">
                <strong>{agent.label}</strong>
                {agent.isDefault && <span className="pill">{t('settings.default')}</span>}
                <br />
                <span className="muted">
                  {agent.version ?? agent.reason ?? t('common.unknown')}
                </span>
              </span>
              <code className="mono">{agent.command}</code>
            </li>
          ))}
          {agents === null && <li className="muted">{t('settings.probingHint')}</li>}
        </ul>
      </section>

      <section>
        <span className="label">{t('settings.defaultAgent')}</span>
        <p className="settings-note">{t('settings.defaultAgentNote')}</p>
      </section>
    </>
  )
}
