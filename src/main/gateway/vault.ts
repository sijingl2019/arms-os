import { GatewayError } from './types'

/**
 * Credential storage (Connector Gateway 设计文档 §10.4).
 *
 * Business code only ever holds a `vault://<id>` reference; the plaintext is
 * decrypted at the moment of the downstream call and never written anywhere.
 */
export interface CredentialVault {
  readonly kind: 'electron-safe-storage' | 'refusing' | 'memory'
  isAvailable(): boolean
  set(id: string, plaintext: string): Promise<void>
  get(id: string): Promise<string>
  has(id: string): Promise<boolean>
  remove(id: string): Promise<void>
  list(): Promise<string[]>
}

export const VAULT_SCHEME = 'vault://'

/** `vault://gmail-oauth` -> `gmail-oauth`. Returns null for a non-reference. */
export function parseCredentialRef(ref: string | undefined): string | null {
  if (!ref) return null
  return ref.startsWith(VAULT_SCHEME) ? ref.slice(VAULT_SCHEME.length) : null
}

/**
 * The vault outside Electron.
 *
 * `safeStorage` is bound to the OS keychain and simply does not exist in a
 * plain Node process, so the CLI and the test runner have no way to decrypt
 * anything. Refusing loudly is the only safe answer: the tempting alternative -
 * a plaintext or self-managed-key fallback - would quietly downgrade every
 * credential the moment someone ran the CLI.
 */
export class RefusingVault implements CredentialVault {
  readonly kind = 'refusing' as const

  isAvailable(): boolean {
    return false
  }

  private fail(): never {
    throw new GatewayError(
      'vault_unavailable',
      'credentials are sealed by the OS keychain and are only readable inside the ARMS ' +
        'desktop app; run this connector from the app rather than the CLI'
    )
  }

  async set(_id: string, _plaintext: string): Promise<void> {
    this.fail()
  }
  async get(_id: string): Promise<string> {
    this.fail()
  }
  async has(_id: string): Promise<boolean> {
    return false
  }
  async remove(_id: string): Promise<void> {
    this.fail()
  }
  async list(): Promise<string[]> {
    return []
  }
}

/** Test double. Never selected automatically - callers must opt in. */
export class MemoryVault implements CredentialVault {
  readonly kind = 'memory' as const
  private readonly store = new Map<string, string>()

  isAvailable(): boolean {
    return true
  }

  async set(id: string, plaintext: string): Promise<void> {
    this.store.set(id, plaintext)
  }

  async get(id: string): Promise<string> {
    const value = this.store.get(id)
    if (value === undefined) throw new GatewayError('credential_missing', `no credential: ${id}`)
    return value
  }

  async has(id: string): Promise<boolean> {
    return this.store.has(id)
  }

  async remove(id: string): Promise<void> {
    this.store.delete(id)
  }

  async list(): Promise<string[]> {
    return [...this.store.keys()].sort()
  }
}

/** What the Electron implementation needs; injected so this file stays testable. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

export interface CipherStore {
  read(): Promise<Record<string, string>>
  write(value: Record<string, string>): Promise<void>
}

/**
 * Ciphertext is safe to keep on disk: `safeStorage` binds decryption to this
 * machine and this OS user, so a stolen file cannot be opened elsewhere.
 */
export class SafeStorageVault implements CredentialVault {
  readonly kind = 'electron-safe-storage' as const
  private readonly safeStorage: SafeStorageLike
  private readonly store: CipherStore

  constructor(safeStorage: SafeStorageLike, store: CipherStore) {
    this.safeStorage = safeStorage
    this.store = store
  }

  isAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private assertAvailable(): void {
    if (this.isAvailable()) return
    throw new GatewayError(
      'vault_unavailable',
      'the OS keychain is not available, so credentials cannot be encrypted'
    )
  }

  async set(id: string, plaintext: string): Promise<void> {
    this.assertAvailable()
    const all = await this.store.read()
    all[id] = this.safeStorage.encryptString(plaintext).toString('base64')
    await this.store.write(all)
  }

  async get(id: string): Promise<string> {
    this.assertAvailable()
    const cipher = (await this.store.read())[id]
    if (cipher === undefined) throw new GatewayError('credential_missing', `no credential: ${id}`)
    return this.safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  }

  async has(id: string): Promise<boolean> {
    return (await this.store.read())[id] !== undefined
  }

  async remove(id: string): Promise<void> {
    const all = await this.store.read()
    delete all[id]
    await this.store.write(all)
  }

  async list(): Promise<string[]> {
    return Object.keys(await this.store.read()).sort()
  }
}
