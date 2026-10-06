import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyCapabilities } from './legacy-capability-migration'

describe('migrateLegacyCapabilities', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'legacy-migration-test-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    delete process.env.PROMA_TEST_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('无 settings 文件时不迁移', () => {
    const result = migrateLegacyCapabilities()
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('settings_not_found')
  })

  test('已有迁移标记时不重复迁移', () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ legacyCapabilitiesMigratedAt: '2026-01-01T00:00:00.000Z' }))
    const result = migrateLegacyCapabilities()
    expect(result.migrated).toBe(false)
    expect(result.reason).toBe('already_migrated')
  })

  test('有旧能力开关时写入迁移标记', () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ marketingCapabilities: ['influencer'] }))
    const result = migrateLegacyCapabilities()
    expect(result.migrated).toBe(true)
  })
})
