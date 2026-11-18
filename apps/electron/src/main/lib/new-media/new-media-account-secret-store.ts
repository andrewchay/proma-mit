import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@gravitas/shared/utils/node'
import type { NewMediaCredentialProtection } from '@gravitas/shared'
import { getRuntimeSecretCodec } from '../agent-runtime/runtime-secret-codec'
import { getNewMediaDir } from '../config-paths'
import type { AuthorizationMaterial } from './platform-adapter'

const SECRET_SCOPE = 'New Media Account Authorization'

/** Linux 的 basic_text 使用公开的固定密码，不视为安全加密。 */
export function hasStrongSafeStorage(storage: { isEncryptionAvailable(): boolean; getSelectedStorageBackend?: () => string } | undefined, platform = process.platform): boolean {
  if (!storage?.isEncryptionAvailable()) return false
  if (platform !== 'linux') return true
  const backend = storage.getSelectedStorageBackend?.()
  return Boolean(backend && backend !== 'basic_text' && backend !== 'unknown')
}

function getStorePath(): string {
  return join(getNewMediaDir(), 'account-secrets.enc')
}

function readAll(): Record<string, AuthorizationMaterial> {
  const path = getStorePath()
  if (!existsSync(path)) return {}
  const encoded = readFileSync(path, 'utf-8')
  const plain = getRuntimeSecretCodec().decode(encoded, SECRET_SCOPE)
  return JSON.parse(plain) as Record<string, AuthorizationMaterial>
}

function writeAll(values: Record<string, AuthorizationMaterial>, requireEncryption = false): void {
  let encoded: string
  if (requireEncryption || Object.values(values).some(value => value.requireEncryption)) {
    try {
      const electron = createRequire(import.meta.url)('electron') as { safeStorage?: typeof import('electron').safeStorage }
      if (!hasStrongSafeStorage(electron.safeStorage)) throw new Error('unavailable')
      if (!electron.safeStorage) throw new Error('unavailable')
      encoded = electron.safeStorage.encryptString(JSON.stringify(values)).toString('base64')
    } catch { throw new Error('系统安全存储不可用，无法加密公众号凭据') }
  } else encoded = getRuntimeSecretCodec().encode(JSON.stringify(values), SECRET_SCOPE)
  writeFileAtomic(getStorePath(), encoded)
}

export function saveNewMediaAccountSecret(credentialRef: string, material: AuthorizationMaterial, options: { requireEncryption?: boolean } = {}): void {
  const values = readAll()
  values[credentialRef] = { ...material, scopes: material.scopes ? [...material.scopes] : undefined }
  writeAll(values, options.requireEncryption)
}

export function loadNewMediaAccountSecret(credentialRef: string): AuthorizationMaterial | undefined {
  const value = readAll()[credentialRef]
  return value ? { ...value, scopes: value.scopes ? [...value.scopes] : undefined } : undefined
}

export function hasNewMediaAccountSecret(credentialRef: string): boolean {
  return credentialRef in readAll()
}

export function removeNewMediaAccountSecret(credentialRef: string): boolean {
  const values = readAll()
  if (!(credentialRef in values)) return false
  delete values[credentialRef]
  writeAll(values)
  return true
}

export function getNewMediaCredentialProtection(): NewMediaCredentialProtection {
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron') as { safeStorage?: { isEncryptionAvailable(): boolean; getSelectedStorageBackend?: () => string } }
    return hasStrongSafeStorage(electron.safeStorage) ? 'encrypted' : 'degraded'
  } catch {
    return 'degraded'
  }
}
