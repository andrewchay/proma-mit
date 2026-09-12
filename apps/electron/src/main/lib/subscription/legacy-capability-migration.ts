import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getSettingsPath } from '../config-paths'

export interface LegacyCapabilityMigrationResult {
  migrated: boolean
  reason?: string
}

/**
 * 将旧版本地能力包开关迁移为订阅引导提示。
 *
 * 商业化阶段不再以 settings.json 的 marketingCapabilities / domainCapabilities
 * 作为权威订阅来源，而是提示用户登录订阅账号。该函数只负责记录迁移标记，
 * 不直接授予任何付费权益。
 */
export function migrateLegacyCapabilities(): LegacyCapabilityMigrationResult {
  const path = getSettingsPath()
  if (!existsSync(path)) return { migrated: false, reason: 'settings_not_found' }

  try {
    const settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (settings.legacyCapabilitiesMigratedAt) return { migrated: false, reason: 'already_migrated' }

    const marketing = Array.isArray(settings.marketingCapabilities) ? settings.marketingCapabilities : []
    const domain = Array.isArray(settings.domainCapabilities) ? settings.domainCapabilities : []
    if (marketing.length === 0 && domain.length === 0) return { migrated: false, reason: 'no_legacy_capabilities' }

    settings.legacyCapabilitiesMigratedAt = new Date().toISOString()
    writeFileSync(path, JSON.stringify(settings, null, 2), 'utf8')
    return { migrated: true }
  } catch {
    return { migrated: false, reason: 'read_error' }
  }
}
