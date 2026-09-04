import { ArmsBus } from './bus'
import { loadConfig, type ArmsConfig, type ConfigOverrides } from './config'
import { openDb, type Db } from './db'
import { SkillExecutor } from './executor'
import { ConnectorGateway } from './gateway'
import type { CredentialVault } from './gateway/vault'
import { RoutineScheduler } from './routines/scheduler'
import { RoutineStore } from './routines/store'
import { RunStore } from './runs/store'
import { SkillRegistry } from './skills/registry'
import type { Spawner } from './agents/types'
import type { GatewayStatus, RoutineStartupReport } from '@shared/types'

export interface ArmsCore {
  config: ArmsConfig
  db: Db
  bus: ArmsBus
  registry: SkillRegistry
  runs: RunStore
  routines: RoutineStore
  scheduler: RoutineScheduler
  gateway: ConnectorGateway
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
  startGateway(): Promise<{ endpoint: string; expired: number; issues: string[] }>
  gatewayStatus(): GatewayStatus
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
  const routines = new RoutineStore(db)
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
    // A routine pointing at a deleted skill must not fire; the scheduler asks
    // the registry rather than guessing.
    hasSkill: (skillId) => registry.get(skillId) !== undefined,
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

  const interrupted = executor.reconcile()
  executor.start()

  const core: ArmsCore = {
    config,
    db,
    bus,
    registry,
    runs,
    routines,
    scheduler,
    gateway,
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
    close: async () => {
      scheduler.stop()
      executor.stop()
      // Let pending runs.log appends land before the process goes away.
      await runs.flush()
      await gateway.stop()
      bus.removeAll()
      db.close()
    }
  }

  return core
}
