/**
 * Shell copy in both languages.
 *
 * Scope is deliberately the shell - desktop, Dock, search, window chrome and
 * Settings. The six data panels behind the Dock are still English-only; they
 * were written that way and translating them is its own pass.
 */

export type Locale = 'zh' | 'en'

export const LOCALES: readonly Locale[] = ['zh', 'en']

const zh = {
  'common.loading': '加载中…',
  'common.refresh': '刷新',
  'common.close': '关闭',
  'common.unknown': '未知',
  'common.none': '无',
  'common.never': '从未',

  'dock.title': '应用坞',
  'dock.home': '桌面',
  'panel.Skills': 'Skills',
  'panel.Routines': 'Routines',
  'panel.Runs': 'Runs',
  'panel.Memory': 'Memory',
  'panel.Gateway': 'Gateway',
  'panel.Settings': '设置',

  'overlay.back': '返回桌面',
  'overlay.esc': 'Esc 返回',
  'overlay.crashed': '这个面板渲染失败：{message}',
  'overlay.crashedHint': '其余部分仍可使用，按 Esc 返回桌面。',

  'win.minimize': '最小化',
  'win.maximize': '最大化',
  'win.restore': '还原',
  'win.hide': '隐藏到托盘',
  'win.language': '切换到 English',
  'win.themeToLight': '切换到浅色',
  'win.themeToDark': '切换到深色',

  'widget.open': '打开 {panel}',
  'widget.notWired': '未接入',

  'apps.title': 'Apps',
  'apps.summary': '{enabled}/{total} 个 connector · {tools} 个 tool',
  'apps.none': 'manifest 里还没有 connector',
  'apps.error': '错误',
  'apps.endpointDown': 'MCP 端点未监听',

  'calendar.title': 'Calendar',
  'calendar.note': '日历还没有接入。接入方式是给 Gateway 加一个日历 connector，然后这里换成真实日程。',

  'email.title': 'Email',
  'email.note': '邮箱还没有接入。同样走 Gateway connector，凭据由 safeStorage 保管。',

  'git.title': 'Git',
  'git.notRepo': '不是 Git 仓库',
  'git.clean': '干净',
  'git.dirty': '{count} 处改动',
  'git.detached': '游离 HEAD',
  'git.noCommits': '还没有提交',

  'skills.title': 'Skills',
  'skills.summary': '{total} 个 Skill · 工作区 {workspace} 个',
  'skills.health': '体检',
  'skills.healthPass': '全部通过',
  'skills.healthWarn': '{count} 个有提醒',
  'skills.healthFail': '{count} 个不通过',
  'skills.lines': '{count} 行',

  'routines.title': 'Routines',
  'routines.summary': '{enabled}/{total} 个启用',
  'routines.none': '没有已排期的 Routine',
  'routines.imminent': '即将触发',
  'routines.inMinutes': '{count} 分钟后',
  'routines.inHours': '{count} 小时后',

  'search.hint': '点击搜索知识库',
  'search.label': '搜索知识库',
  'search.placeholder': '搜索知识库…',
  'search.empty': '没有匹配的内容',
  'search.notIndexed': '知识库还没有索引任何文件。',
  'search.goMemory': '去 Memory 面板做一次 refresh',

  'settings.general': '常规',
  'settings.generalHint': '路径、外观与调度器状态',
  'settings.agents': 'Agents',
  'settings.agentsHint': '可用的 CLI 与默认 agent',
  'settings.categories': '设置分类',
  'settings.readOnly':
    '这些值来自默认设置与环境变量，改动后需要重启应用。ARMS 目前没有可写的配置存储，所以这里只读。',
  'settings.paths': '路径',
  'settings.workspace': '工作区',
  'settings.stateDir': '状态目录',
  'settings.database': '数据库',
  'settings.runLog': '运行日志',
  'settings.scanRoots': 'Skill 扫描目录',
  'settings.runtime': '运行状态',
  'settings.indexedSkills': '已索引 Skill',
  'settings.routines': 'Routine',
  'settings.nextTrigger': '下次触发',
  'settings.interrupted': '中断的运行',
  'settings.interruptedCount': '{count} 条已从上次会话回收',
  'settings.schedulerBoot': '调度器启动',
  'settings.schedulerLine': '载入 {loaded} · 错过 {missed} · 补跑 {caughtUp} · 跳过 {skipped}',
  'settings.schedulerOff': '未启动',
  'settings.maintenance': '维护',
  'settings.rescan': '重扫 Skill',
  'settings.rescanDone': '重扫完成：新增 {added} · 更新 {updated} · 移除 {removed}',
  'settings.writeIndex': '生成 SKILLS_INDEX.md',
  'settings.written': '已写入 {file}',
  'settings.appearance': '外观',
  'settings.appearanceNote': '语言与主题也可以直接在桌面右上角切换，选择保存在本机。',
  'settings.language': '语言',
  'settings.theme': '主题',
  'settings.themeDark': '深色',
  'settings.themeLight': '浅色',
  'settings.agentsNote':
    'Skill 通过 headless 子进程执行，模型能力不内嵌在本应用里。下面是每个 CLI 的实际可用性 —— 默认 agent 不可用时，每一次运行和每一条 Routine 都会以 spawn 失败告终。',
  'settings.installedClis': '已安装的 CLI',
  'settings.probing': '探测中…',
  'settings.reprobe': '重新探测',
  'settings.probingHint': '正在运行 --version…',
  'settings.default': '默认',
  'settings.defaultAgent': '默认 agent',
  'settings.defaultAgentNote':
    '由 defaultAgent 配置项决定，目前固定为 claude。单次运行仍可在 Skills 面板里临时指定别的 agent。'
} as const

export type MessageKey = keyof typeof zh

const en: Record<MessageKey, string> = {
  'common.loading': 'Loading…',
  'common.refresh': 'Refresh',
  'common.close': 'Close',
  'common.unknown': 'unknown',
  'common.none': 'none',
  'common.never': 'never',

  'dock.title': 'Dock',
  'dock.home': 'Desktop',
  'panel.Skills': 'Skills',
  'panel.Routines': 'Routines',
  'panel.Runs': 'Runs',
  'panel.Memory': 'Memory',
  'panel.Gateway': 'Gateway',
  'panel.Settings': 'Settings',

  'overlay.back': 'Back to desktop',
  'overlay.esc': 'Esc to go back',
  'overlay.crashed': 'This panel failed to render: {message}',
  'overlay.crashedHint': 'Everything else still works. Press Esc to go back.',

  'win.minimize': 'Minimize',
  'win.maximize': 'Maximize',
  'win.restore': 'Restore',
  'win.hide': 'Hide to tray',
  'win.language': '切换到中文',
  'win.themeToLight': 'Switch to light',
  'win.themeToDark': 'Switch to dark',

  'widget.open': 'Open {panel}',
  'widget.notWired': 'not wired up',

  'apps.title': 'Apps',
  'apps.summary': '{enabled}/{total} connectors · {tools} tools',
  'apps.none': 'No connectors in the manifest yet',
  'apps.error': 'error',
  'apps.endpointDown': 'MCP endpoint is not listening',

  'calendar.title': 'Calendar',
  'calendar.note':
    'No calendar yet. Add a calendar connector to the Gateway, then this becomes real events.',

  'email.title': 'Email',
  'email.note':
    'No mailbox yet. Same route - a Gateway connector, with credentials held by safeStorage.',

  'git.title': 'Git',
  'git.notRepo': 'Not a Git repository',
  'git.clean': 'clean',
  'git.dirty': '{count} changes',
  'git.detached': 'detached HEAD',
  'git.noCommits': 'No commits yet',

  'skills.title': 'Skills',
  'skills.summary': '{total} skills · {workspace} in the workspace',
  'skills.health': 'Health',
  'skills.healthPass': 'all passing',
  'skills.healthWarn': '{count} with warnings',
  'skills.healthFail': '{count} failing',
  'skills.lines': '{count} lines',

  'routines.title': 'Routines',
  'routines.summary': '{enabled}/{total} enabled',
  'routines.none': 'Nothing scheduled',
  'routines.imminent': 'any moment',
  'routines.inMinutes': 'in {count} min',
  'routines.inHours': 'in {count} h',

  'search.hint': 'Click to search the knowledge base',
  'search.label': 'Search the knowledge base',
  'search.placeholder': 'Search the knowledge base…',
  'search.empty': 'Nothing matched',
  'search.notIndexed': 'The knowledge base has no indexed files yet.',
  'search.goMemory': 'Refresh it from the Memory panel',

  'settings.general': 'General',
  'settings.generalHint': 'Paths, appearance and scheduler state',
  'settings.agents': 'Agents',
  'settings.agentsHint': 'Installed CLIs and the default agent',
  'settings.categories': 'Settings categories',
  'settings.readOnly':
    'These come from defaults and environment variables, and a change needs a restart. ARMS has no writable config store yet, so this is read-only.',
  'settings.paths': 'Paths',
  'settings.workspace': 'Workspace',
  'settings.stateDir': 'State directory',
  'settings.database': 'Database',
  'settings.runLog': 'Run log',
  'settings.scanRoots': 'Skill scan roots',
  'settings.runtime': 'Runtime',
  'settings.indexedSkills': 'Indexed skills',
  'settings.routines': 'Routines',
  'settings.nextTrigger': 'Next trigger',
  'settings.interrupted': 'Interrupted runs',
  'settings.interruptedCount': '{count} reconciled from a previous session',
  'settings.schedulerBoot': 'Scheduler startup',
  'settings.schedulerLine':
    'loaded {loaded} · missed {missed} · caught up {caughtUp} · skipped {skipped}',
  'settings.schedulerOff': 'not started',
  'settings.maintenance': 'Maintenance',
  'settings.rescan': 'Rescan skills',
  'settings.rescanDone': 'Rescanned: {added} added · {updated} updated · {removed} removed',
  'settings.writeIndex': 'Write SKILLS_INDEX.md',
  'settings.written': 'Wrote {file}',
  'settings.appearance': 'Appearance',
  'settings.appearanceNote':
    'Language and theme can also be switched from the top right of the desktop. The choice is stored on this machine.',
  'settings.language': 'Language',
  'settings.theme': 'Theme',
  'settings.themeDark': 'Dark',
  'settings.themeLight': 'Light',
  'settings.agentsNote':
    'Skills run as headless child processes; no model is embedded in this app. Below is whether each CLI is actually there - when the default agent is missing, every run and every routine ends as a spawn error.',
  'settings.installedClis': 'Installed CLIs',
  'settings.probing': 'Probing…',
  'settings.reprobe': 'Probe again',
  'settings.probingHint': 'Running --version…',
  'settings.default': 'default',
  'settings.defaultAgent': 'Default agent',
  'settings.defaultAgentNote':
    'Set by the defaultAgent config value, currently fixed to claude. A single run can still pick another agent from the Skills panel.'
}

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { zh, en }

/** Substitute `{name}` placeholders. Missing values are left as-is, visibly. */
export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })
}
