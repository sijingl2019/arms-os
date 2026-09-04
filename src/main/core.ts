import { ArmsBus } from './bus'
import { loadConfig, type ArmsConfig, type ConfigOverrides } from './config'
import { openDb, type Db } from './db'
import { SkillExecutor } from './executor'
import { RoutineScheduler } from './routines/scheduler'
import { RoutineStore } from './routines/store'
import { RunStore } from './runs/store'
import { SkillRegistry } from './skills/registry'
import type { Spawner } from './agents/types'
import type { RoutineStartupReport } from '@shared/types'

export interface ArmsCore {
  config: ArmsConfig
  db: Db
  bus: ArmsBus
  registry: SkillRegistry
  runs: RunStore
  routines: RoutineStore
  scheduler: RoutineScheduler
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
  close(): void
}

export interface CreateCoreOptions extends ConfigOverrides {
  spawner?: Spawner
  /** Overridden in tests to avoid waiting on the real 20s cadence. */
  tickMs?: number
}

/**
 * Composition root for the OS Core Services. The Electron main process will
 * call this once at `app.whenReady()`; the CLI calls it per command.
 */
export function createCore({ spawner, tickMs, ...overrides }: CreateCoreOptions = {}): ArmsCore {
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
    ...(tickMs === undefined ? {} : { tickMs })
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
    executor,
    interrupted,
    schedulerReport: null,
    startScheduler: (now) => {
      const report = scheduler.start(now)
      core.schedulerReport = report
      return report
    },
    close: () => {
      scheduler.stop()
      executor.stop()
      bus.removeAll()
      db.close()
    }
  }

  return core
}
