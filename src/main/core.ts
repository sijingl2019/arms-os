import { ArmsBus } from './bus'
import { loadConfig, type ArmsConfig, type ConfigOverrides } from './config'
import { openDb, type Db } from './db'
import { SkillExecutor } from './executor'
import { RunStore } from './runs/store'
import { SkillRegistry } from './skills/registry'
import type { Spawner } from './agents/types'

export interface ArmsCore {
  config: ArmsConfig
  db: Db
  bus: ArmsBus
  registry: SkillRegistry
  runs: RunStore
  executor: SkillExecutor
  /** Number of runs reconciled from a previous session. */
  interrupted: number
  close(): void
}

export interface CreateCoreOptions extends ConfigOverrides {
  spawner?: Spawner
}

/**
 * Composition root for the OS Core Services. The Electron main process will
 * call this once at `app.whenReady()`; the CLI calls it per command.
 */
export function createCore({ spawner, ...overrides }: CreateCoreOptions = {}): ArmsCore {
  const config = loadConfig(overrides)
  const db = openDb(config.dbPath)
  const bus = new ArmsBus()

  const registry = new SkillRegistry({ db, config, bus })
  const runs = new RunStore({ db, logPath: config.runLogPath })
  const executor = new SkillExecutor({
    registry,
    runs,
    config,
    bus,
    ...(spawner ? { spawner } : {})
  })

  const interrupted = executor.reconcile()
  executor.start()

  return {
    config,
    db,
    bus,
    registry,
    runs,
    executor,
    interrupted,
    close: () => {
      executor.stop()
      bus.removeAll()
      db.close()
    }
  }
}
