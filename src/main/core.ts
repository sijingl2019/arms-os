import path from 'node:path'
import { ArmsBus } from './bus'
import { loadConfig, type ArmsConfig, type ConfigOverrides } from './config'
import { openDb, type Db } from './db'
import { SkillExecutor } from './executor'
import { ConnectorGateway } from './gateway'
import { MemoryIndexer } from './memory/indexer'
import { MemoryStore } from './memory/store'
import { SETTING_KEYS, SettingsStore } from './settings'
import type { CredentialVault } from './gateway/vault'
import { RoutineScheduler } from './routines/scheduler'
import { RoutineStore } from './routines/store'
import { checkRoutineTarget, explainTargetProblem } from './routines/target'
import { ToolRoutineRunner } from './routines/toolRunner'
import { RunStore } from './runs/store'
import { SkillRegistry } from './skills/registry'
import type { Spawner } from './agents/types'
import type { GatewayStatus, RoutineStartupReport } from '@shared/types'
import type { ToolResult } from './gateway/types'

export interface ArmsCore {
  config: ArmsConfig
  db: Db
  bus: ArmsBus
  registry: SkillRegistry
  runs: RunStore
  routines: RoutineStore
  scheduler: RoutineScheduler
  memory: MemoryStore
  indexer: MemoryIndexer
  settings: SettingsStore
  /**
   * Replace the knowledge-base roots and persist the choice.
   *
   * Rows belonging to a dropped root are deleted here rather than left for the
   * next sweep: a sweep only reconciles the roots it walks, so a removed vault's
   * files would otherwise stay searchable forever.
   */
  setMemoryRoots(roots: string[]): { roots: string[]; pruned: number }
  gateway: ConnectorGateway
  toolRunner: ToolRoutineRunner
  executor: SkillExecutor
  /** Number of runs reconciled from a previous session. */
  interrupted: number
  /** Populated once `startScheduler()` has run. */
  schedulerReport: RoutineStartupReport | null
  /**
   * Begin ticking. Kept out of `createCore` so a one-shot CLI command can build
   * the graph without a scheduler suddenly firing routines behind it.
   */
  startScheduler(now?: Date): RoutineStartupReport
  /**
   * Bind the loopback MCP endpoint. Separate from `createCore` so a one-shot
   * CLI command can inspect the graph without opening a port.
   */
  startGateway(): Promise<Awaited<ReturnType<ConnectorGateway['start']>>>
  gatewayStatus(): GatewayStatus
  /** Invoke one tool through the full middleware chain. */
  dispatchTool(qualifiedName: string, args: Record<string, unknown>): Promise<ToolResult>
  close(): Promise<void>
}

export interface CreateCoreOptions extends ConfigOverrides {
  spawner?: Spawner
  /** Overridden in tests to avoid waiting on the real 20s cadence. */
  tickMs?: number
  /** Overridden in tests so scheduling is not driven by the wall clock. */
  clock?: () => Date
  /** Defaults to the refusing vault, which is the right answer outside Electron. */
  vault?: CredentialVault
  gatewayPort?: number
}

/**
 * Composition root for the OS Core Services. The Electron main process will
 * call this once at `app.whenReady()`; the CLI calls it per command.
 */
export function createCore({
  spawner,
  tickMs,
  clock,
  vault,
  gatewayPort,
  ...overrides
}: CreateCoreOptions = {}): ArmsCore {
  const config = loadConfig(overrides)
  const db = openDb(config.dbPath)
  const bus = new ArmsBus()

  const registry = new SkillRegistry({ db, config, bus })
  const runs = new RunStore({ db, logPath: config.runLogPath })
  // Declared before the store so the target checker can close over the
  // registry and gateway, which are built below.
  const resolvers = {
    hasSkill: (skillId: string): boolean => registry.get(skillId) !== undefined,
    riskOfTool: (qualifiedName: string) =>
      gateway.registry.tools().find((t) => t.qualifiedName === qualifiedName)?.risk
  }

  const routines = new RoutineStore(db, (target) => {
    const problem = checkRoutineTarget(target, resolvers)
    return problem ? explainTargetProblem(problem, target) : null
  })
  const memory = new MemoryStore(db)
  const settings = new SettingsStore(db)

  // A stored choice outranks the environment: once someone has picked a folder
  // in the UI it has to survive a restart, which an env var cannot express.
  const storedRoots = settings.getList(SETTING_KEYS.memoryRoots)
  if (storedRoots) config.memoryRoots = storedRoots
  const storedRouter = settings.get(SETTING_KEYS.memoryRouterRoot)
  config.memoryRouterRoot = storedRouter ?? config.memoryRoots[0] ?? null

  const indexer = new MemoryIndexer({ store: memory, config, bus })
  const executor = new SkillExecutor({
    registry,
    runs,
    config,
    bus,
    ...(spawner ? { spawner } : {})
  })

  const scheduler = new RoutineScheduler({
    store: routines,
    bus,
    // Re-checked at every firing, not trusted from creation: the connector
    // manifest can change underneath a scheduled routine.
    checkTarget: (target) => checkRoutineTarget(target, resolvers),
    ...(tickMs === undefined ? {} : { tickMs }),
    ...(clock === undefined ? {} : { clock })
  })

  const gateway = new ConnectorGateway({
    db,
    bus,
    config,
    ...(vault ? { vault } : {}),
    ...(spawner ? { spawner } : {}),
    ...(gatewayPort === undefined ? {} : { port: gatewayPort })
  })

  const toolRunner = new ToolRoutineRunner({
    store: routines,
    dispatcher: gateway.dispatcher,
    bus
  })

  const interrupted = executor.reconcile()
  executor.start()
  toolRunner.start()

  const core: ArmsCore = {
    config,
    db,
    bus,
    registry,
    runs,
    routines,
    scheduler,
    memory,
    indexer,
    settings,
    setMemoryRoots: (roots) => {
      const next = [...new Set(roots.map((r) => path.resolve(r)))]
      const dropped = config.memoryRoots.filter((r) => !next.includes(r))

      let pruned = 0
      for (const root of dropped) pruned += memory.removeRoot(root)

      // The config object is shared by reference, so the indexer sees this.
      config.memoryRoots = next
      settings.setList(SETTING_KEYS.memoryRoots, next)

      if (!storedRouter) {
        config.memoryRouterRoot = next[0] ?? null
      }

      bus.emit('memory:index:completed', {
        ...(indexer.status().lastResult ?? {
          added: 0,
          updated: 0,
          removed: pruned,
          unchanged: 0,
          skipped: 0,
          durationMs: 0,
          warnings: [],
          routerFiles: []
        })
      })
      return { roots: next, pruned }
    },
    gateway,
    toolRunner,
    executor,
    interrupted,
    schedulerReport: null,
    startScheduler: (now) => {
      const report = scheduler.start(now)
      core.schedulerReport = report
      return report
    },
    startGateway: () => gateway.start(),
    gatewayStatus: () => gateway.status(),
    dispatchTool: (qualifiedName, args) => gateway.dispatcher.call({ qualifiedName, args }),
    close: async () => {
      scheduler.stop()
      toolRunner.stop()
      executor.stop()
      // Let work that was started but not awaited finish before the database
      // goes away: a tool call still running would otherwise lose its result.
      await toolRunner.flush()
      await runs.flush()
      await gateway.stop()
      bus.removeAll()
      db.close()
    }
  }

  return core
}
