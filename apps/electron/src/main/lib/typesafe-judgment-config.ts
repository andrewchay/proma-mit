import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  TYPESAFE_JUDGMENT_MODEL,
  type TypeSafeJudgmentSettings,
  type UpdateTypeSafeJudgmentSettingsInput,
} from '@gravitas/shared'
import { getConfigDir } from './config-paths'

interface StoredTypeSafeJudgmentConfig {
  schemaVersion: 1
  enabled: boolean
  skillShadowEnabled: boolean
  chatAgentRecommendEnabled: boolean
  model: typeof TYPESAFE_JUDGMENT_MODEL
}

const DEFAULT_CONFIG: StoredTypeSafeJudgmentConfig = {
  schemaVersion: 1,
  enabled: false,
  skillShadowEnabled: false,
  chatAgentRecommendEnabled: false,
  model: TYPESAFE_JUDGMENT_MODEL,
}

let memoryApiKey: string | null = null

function getTypeSafeDir(): string {
  const dir = join(getConfigDir(), 'typesafe')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function getConfigPath(): string {
  return join(getTypeSafeDir(), 'config.json')
}

function getSecretPath(): string {
  return join(getTypeSafeDir(), 'api-key.bin')
}

function readStoredConfig(): StoredTypeSafeJudgmentConfig {
  const path = getConfigPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredTypeSafeJudgmentConfig>
    return {
      ...DEFAULT_CONFIG,
      enabled: parsed.enabled === true,
      skillShadowEnabled: parsed.skillShadowEnabled === true,
      chatAgentRecommendEnabled: parsed.chatAgentRecommendEnabled === true,
    }
  } catch (error) {
    console.warn('[TypeSafe] 读取判断服务配置失败，使用默认配置:', error)
    return { ...DEFAULT_CONFIG }
  }
}

function writeStoredConfig(config: StoredTypeSafeJudgmentConfig): void {
  const path = getConfigPath()
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

function hasEncryptedApiKey(): boolean {
  return existsSync(getSecretPath())
}

export function getTypeSafeJudgmentSettings(): TypeSafeJudgmentSettings {
  const config = readStoredConfig()
  const encrypted = safeStorage.isEncryptionAvailable() && hasEncryptedApiKey()
  return {
    enabled: config.enabled,
    skillShadowEnabled: config.skillShadowEnabled,
    chatAgentRecommendEnabled: config.chatAgentRecommendEnabled,
    model: TYPESAFE_JUDGMENT_MODEL,
    hasApiKey: Boolean(memoryApiKey) || encrypted,
    credentialStorage: memoryApiKey ? 'memory' : encrypted ? 'encrypted' : 'none',
  }
}

export function updateTypeSafeJudgmentSettings(
  input: UpdateTypeSafeJudgmentSettingsInput,
): TypeSafeJudgmentSettings {
  const current = readStoredConfig()
  const next: StoredTypeSafeJudgmentConfig = {
    ...current,
    enabled: input.enabled ?? current.enabled,
    skillShadowEnabled: input.skillShadowEnabled ?? current.skillShadowEnabled,
    chatAgentRecommendEnabled: input.chatAgentRecommendEnabled ?? current.chatAgentRecommendEnabled,
    model: TYPESAFE_JUDGMENT_MODEL,
  }

  const apiKey = input.apiKey?.trim()
  if (apiKey) {
    if (safeStorage.isEncryptionAvailable()) {
      const secretPath = getSecretPath()
      writeFileSync(secretPath, safeStorage.encryptString(apiKey), { mode: 0o600 })
      try { chmodSync(secretPath, 0o600) } catch {}
      memoryApiKey = null
    } else {
      memoryApiKey = apiKey
      rmSync(getSecretPath(), { force: true })
      console.warn('[TypeSafe] safeStorage 不可用，API Key 仅保存在当前进程内存中')
    }
  }

  writeStoredConfig(next)
  return getTypeSafeJudgmentSettings()
}

export function getTypeSafeApiKey(): string | null {
  if (memoryApiKey) return memoryApiKey
  const secretPath = getSecretPath()
  if (!existsSync(secretPath) || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(readFileSync(secretPath))
  } catch (error) {
    console.warn('[TypeSafe] 解密 API Key 失败:', error)
    return null
  }
}

export function clearTypeSafeApiKey(): TypeSafeJudgmentSettings {
  memoryApiKey = null
  rmSync(getSecretPath(), { force: true })
  writeStoredConfig({ ...readStoredConfig(), enabled: false })
  return getTypeSafeJudgmentSettings()
}

/** 仅供隔离测试重置进程内密钥。 */
export function resetTypeSafeMemoryCredentialForTest(): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.PROMA_TEST_CONFIG_DIR) return
  memoryApiKey = null
}
