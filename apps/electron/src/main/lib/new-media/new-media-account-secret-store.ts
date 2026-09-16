import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@gravitas/shared/utils/node'
import type { NewMediaCredentialProtection } from '@gravitas/shared'
import { getRuntimeSecretCodec } from '../agent-runtime/runtime-secret-codec'
import { getNewMediaDir } from '../config-paths'
import type { AuthorizationMaterial } from './platform-adapter'

const SECRET_SCOPE = 'New Media Account Authorization'

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

function writeAll(values: Record<string, AuthorizationMaterial>): void {
  const encoded = getRuntimeSecretCodec().encode(JSON.stringify(values), SECRET_SCOPE)
  writeFileAtomic(getStorePath(), encoded)
}

export function saveNewMediaAccountSecret(credentialRef: string, material: AuthorizationMaterial): void {
  const values = readAll()
  values[credentialRef] = { ...material, scopes: material.scopes ? [...material.scopes] : undefined }
  writeAll(values)
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
    const electron = require('electron') as { safeStorage?: { isEncryptionAvailable(): boolean } }
    return electron.safeStorage?.isEncryptionAvailable() ? 'encrypted' : 'degraded'
  } catch {
    return 'degraded'
  }
}
