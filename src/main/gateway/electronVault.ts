import { promises as fs } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { SafeStorageVault, type CipherStore } from './vault'

/**
 * Ciphertext on disk, decryptable only by this OS user on this machine
 * (Connector Gateway 设计文档 §10.4).
 *
 * Only imported from the Electron main process - `safeStorage` does not exist
 * in a plain Node process, which is exactly why the CLI gets RefusingVault.
 */
function fileStore(file: string): CipherStore {
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, string>)
          : {}
      } catch {
        return {}
      }
    },
    async write(value) {
      await fs.mkdir(path.dirname(file), { recursive: true })
      // Atomic: a crash mid-write must not leave a truncated vault behind.
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
      await fs.rename(tmp, file)
    }
  }
}

export function createElectronVault(stateDir: string): SafeStorageVault {
  return new SafeStorageVault(safeStorage, fileStore(path.join(stateDir, 'credentials.json')))
}
