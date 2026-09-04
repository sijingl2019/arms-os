import { useCallback, useEffect, useState } from 'react'
import type {
  AgentInfo,
  GatewayStatus,
  MemoryIndexProgress,
  MemoryIndexStatus,
  SystemStatus
} from '@shared/types'

/**
 * Settings, laid out like the earlier MVP's: a category rail on the left, one
 * panel on the right.
 *
 * Most of what is here is read-only, and deliberately says so. ARMS builds its
 * configuration from defaults and environment variables (`src/main/config.ts`)
 * and has no user-writable config store yet, so the honest thing is to show the
 * live value next to the variable that changes it, rather than a control that
 * silently does nothing.
 */

const CATEGORIES = [
  { id: 'general', label: '常规', hint: '路径、端口与调度器状态' },
  { id: 'agents', label: 'Agents', hint: '可用的 CLI 与默认 agent' },
  { id: 'connectors', label: 'Connectors', hint: 'manifest、工具与凭据保管' },
  { id: 'memory', label: '知识库', hint: '索引目录与重建' }
] as const

type Category = (typeof CATEGORIES)[number]['id']

export function SettingsPanel(): React.JSX.Element {
  const [category, setCategory] = useState<Category>('general')

  return (
    <div className="settings-split">
      <nav className="settings-nav" aria-label="设置分类">
        {CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={'settings-nav-item' + (category === entry.id ? ' on' : '')}
            aria-current={category === entry.id}
            onClick={() => setCategory(entry.id)}
          >
            <strong>{entry.label}</strong>
            <span className="muted">{entry.hint}</span>
          </button>
        ))}
      </nav>

      <div className="settings-panel">
        {category === 'general' && <GeneralSettings />}
        {category === 'agents' && <AgentSettings />}
        {category === 'connectors' && <ConnectorSettings />}
        {category === 'memory' && <MemorySettings />}
      </div>
    </div>
  )
}

/** A read-only value plus the environment variable that changes it. */
function EnvNote({ name }: { name: string }): React.JSX.Element {
  return <span className="env-note mono">{name}</span>
}

/* ----------------------------------------------------------------- general */

function GeneralSettings(): React.JSX.Element {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.arms.system.status().then(setStatus)
  }, [])

  useEffect(load, [load])

  if (!status) return <p className="empty">加载中…</p>
  const s = status.scheduler

  return (
    <>
      <h2 className="settings-h">常规</h2>
      <p className="settings-note">
        这些值来自默认设置与环境变量，改动后需要重启应用。ARMS 目前没有可写的配置存储，所以这里只读。
      </p>

      <section>
        <span className="label">路径</span>
        <dl className="kv">
          <dt>
            工作区 <EnvNote name="ARMS_WORKSPACE" />
          </dt>
          <dd className="mono">{status.workspaceRoot}</dd>
          <dt>
            状态目录 <EnvNote name="ARMS_STATE_DIR" />
          </dt>
          <dd className="mono">{status.stateDir}</dd>
          <dt>数据库</dt>
          <dd className="mono">{status.dbPath}</dd>
          <dt>运行日志</dt>
          <dd className="mono">{status.runLogPath}</dd>
          <dt>Skill 扫描目录</dt>
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
        <span className="label">运行状态</span>
        <dl className="kv">
          <dt>已索引 Skill</dt>
          <dd>{status.skillCount}</dd>
          <dt>Routine</dt>
          <dd>{status.routineCount}</dd>
          <dt>下次触发</dt>
          <dd>{status.nextTriggerAt ? new Date(status.nextTriggerAt).toLocaleString() : '—'}</dd>
          <dt>中断的运行</dt>
          <dd>
            {status.interruptedRuns > 0
              ? `${status.interruptedRuns} 条已从上次会话回收`
              : '无'}
          </dd>
          <dt>调度器启动</dt>
          <dd>
            {s
              ? `载入 ${s.loaded} · 错过 ${s.missed} · 补跑 ${s.caughtUp} · 跳过 ${s.skipped}`
              : '未启动'}
          </dd>
        </dl>
      </section>

      <section>
        <span className="label">维护</span>
        <div className="row">
          <button onClick={load}>刷新</button>
          <button
            onClick={() => {
              void window.arms.skills.refresh().then((r) => {
                setNote(`重扫完成：新增 ${r.added} · 更新 ${r.updated} · 移除 ${r.removed}`)
              })
            }}
          >
            重扫 Skill
          </button>
          <button
            onClick={() => {
              void window.arms.skills.writeIndex().then((file) => setNote(`已写入 ${file}`))
            }}
          >
            生成 SKILLS_INDEX.md
          </button>
        </div>
        {note && <p className="label">{note}</p>}
      </section>
    </>
  )
}

/* ------------------------------------------------------------------ agents */

function AgentSettings(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null)

  const load = useCallback(() => {
    setAgents(null)
    void window.arms.agents.list().then(setAgents)
  }, [])

  useEffect(load, [load])

  return (
    <>
      <h2 className="settings-h">Agents</h2>
      <p className="settings-note">
        Skill 通过 headless 子进程执行，模型能力不内嵌在本应用里。下面是每个 CLI 的实际可用性
        —— 默认 agent 不可用时，每一次运行和每一条 Routine 都会以 spawn 失败告终。
      </p>

      <section>
        <div className="row">
          <span className="label">已安装的 CLI</span>
          <span className="spacer" />
          <button onClick={load} disabled={agents === null}>
            {agents === null ? '探测中…' : '重新探测'}
          </button>
        </div>
        <ul className="agent-list">
          {(agents ?? []).map((agent) => (
            <li key={agent.id}>
              <span className={'dot' + (agent.available ? ' ok' : ' bad')} />
              <span className="grow">
                <strong>{agent.label}</strong>
                {agent.isDefault && <span className="tag">默认</span>}
                <br />
                <span className="muted">{agent.version ?? agent.reason ?? '未知'}</span>
              </span>
              <code className="mono">{agent.command}</code>
            </li>
          ))}
          {agents === null && <li className="muted">正在运行 --version…</li>}
        </ul>
      </section>

      <section>
        <span className="label">默认 agent</span>
        <p className="settings-note">
          由 <EnvNote name="defaultAgent" /> 配置项决定，目前固定为 <code className="mono">claude</code>
          。单次运行仍可在 Skills 面板里临时指定别的 agent。
        </p>
      </section>
    </>
  )
}

/* -------------------------------------------------------------- connectors */

function ConnectorSettings(): React.JSX.Element {
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [issues, setIssues] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    void window.arms.gateway.status().then(setStatus)
  }, [])

  useEffect(load, [load])

  return (
    <>
      <h2 className="settings-h">Connectors</h2>
      <p className="settings-note">
        Connector 是「手」：所有触达外部世界的动作都经过 Gateway，也只在这里被拦截。审批队列和调用记录在
        Gateway 面板。
      </p>

      <section>
        <span className="label">端点</span>
        <dl className="kv">
          <dt>MCP</dt>
          <dd className="mono">{status?.endpoint ?? '未监听'}</dd>
          <dt>manifest</dt>
          <dd className="mono">{status?.manifestPath ?? '—'}</dd>
          <dt>凭据保管</dt>
          <dd>
            {status ? `${status.vault.kind}（${status.vault.available ? '可用' : '不可用'}）` : '—'}
          </dd>
          <dt>待审批</dt>
          <dd>{status?.pendingConfirmations ?? 0}</dd>
        </dl>
      </section>

      <section>
        <div className="row">
          <span className="label">Connector</span>
          <span className="spacer" />
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void window.arms.gateway
                .reload()
                .then((result) => {
                  setIssues(result)
                  load()
                })
                .finally(() => setBusy(false))
            }}
          >
            {busy ? '重载中…' : '重载 manifest'}
          </button>
        </div>
        <ul className="agent-list">
          {(status?.connectors ?? []).map((c) => (
            <li key={c.id}>
              <span className={'dot' + (c.error ? ' bad' : c.enabled ? ' ok' : '')} />
              <span className="grow">
                <strong>{c.id}</strong>
                <br />
                <span className="muted">
                  {c.transport} · {c.toolCount} 个 tool{c.enabled ? '' : ' · 已停用'}
                  {c.error ? ` · ${c.error}` : ''}
                </span>
              </span>
            </li>
          ))}
          {status && status.connectors.length === 0 && (
            <li className="muted">manifest 里还没有 connector</li>
          )}
        </ul>
        {(issues ?? status?.issues ?? []).map((issue) => (
          <p key={issue} className="error">
            {issue}
          </p>
        ))}
      </section>
    </>
  )
}

/* ------------------------------------------------------------------ memory */

function MemorySettings(): React.JSX.Element {
  const [status, setStatus] = useState<MemoryIndexStatus | null>(null)
  const [progress, setProgress] = useState<MemoryIndexProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void window.arms.memory.status().then(setStatus)
  }, [])

  useEffect(() => {
    load()
    const offs = [
      window.arms.on.memoryProgress(setProgress),
      window.arms.on.memoryCompleted(() => {
        setProgress(null)
        load()
      })
    ]
    return () => offs.forEach((off) => off())
  }, [load])

  const roots = status?.roots ?? []
  const building = status?.indexing === true || progress !== null

  return (
    <>
      <h2 className="settings-h">知识库</h2>
      <p className="settings-note">
        被索引的目录与代码工作区是分开的：知识库很少就是仓库本身。索引让 Memory 面板和桌面中央的搜索都能查到内容。
      </p>

      <section>
        <span className="label">
          索引目录 <EnvNote name="ARMS_MEMORY_ROOTS" />
        </span>
        <ul className="root-list">
          {roots.map((root) => (
            <li key={root} className="mono">
              {root}
            </li>
          ))}
          {roots.length === 0 && (
            <li className="muted">
              还没有配置目录。设置 ARMS_MEMORY_ROOTS（多个用路径分隔符隔开）后重启。
            </li>
          )}
        </ul>
      </section>

      <section>
        <span className="label">路由文件</span>
        <dl className="kv">
          <dt>写入根目录</dt>
          <dd className="mono">{status?.routerRoot ?? '—'}</dd>
          <dt>已索引文件</dt>
          <dd>{status?.totalFiles ?? 0}</dd>
          <dt>上次索引</dt>
          <dd>
            {status?.lastIndexedAt ? new Date(status.lastIndexedAt).toLocaleString() : '从未'}
          </dd>
        </dl>
      </section>

      <section>
        <div className="row">
          <button
            className="primary"
            disabled={building || roots.length === 0}
            onClick={() => {
              setError(null)
              void window.arms.memory
                .refresh({ writeRouter: true })
                .catch((err: Error) => setError(err.message))
            }}
          >
            {building ? '索引中…' : '增量索引并写路由文件'}
          </button>
          <button
            disabled={building || roots.length === 0}
            onClick={() => {
              setError(null)
              void window.arms.memory.refresh({ force: true }).catch((err: Error) =>
                setError(err.message)
              )
            }}
          >
            全量重建
          </button>
        </div>
        {progress && (
          <p className="label mono">
            {progress.phase} · 已看 {progress.seen} · 变更 {progress.changed}
            <br />
            <span className="muted">{progress.currentRoot ?? ''}</span>
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>
    </>
  )
}
