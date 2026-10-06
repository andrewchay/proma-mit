import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { updateSettings } from './settings-service'
import { getMarketingPluginDir, syncMarketingSkillsForWorkspace } from './marketing-skills-sync'
import { buildEntitlementSigningPayload } from './subscription/entitlement-signature'
import type { EntitlementSnapshot } from '@gravitas/shared'

/**
 * 营销 Skills 工作区分发四态测试（增 / 换 / 升 / 清）。
 * 用 PROMA_TEST_CONFIG_DIR 隔离，不触碰真实 ~/.proma-mit。
 *
 * 商业化后：本地 settings 开关只是偏好，实际分发还需已验签权益，
 * 因此测试需通过 writeEntitlement 授予权益。
 */
const tmpConfigDir = mkdtempSync(join(tmpdir(), 'mkt-skills-sync-test-'))
const bundledSkillsDir = join(import.meta.dir, '../../../marketing-skills')

const testKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function writeEntitlement(capabilities: string[]): void {
  const snapshot: EntitlementSnapshot = {
    accountId: 'test-account',
    planId: capabilities.length > 0 ? 'pro' : 'free',
    capabilities: capabilities as EntitlementSnapshot['capabilities'],
    status: 'active',
    lastVerifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    signature: '',
    keyId: 'test-1',
  }
  const signature = createSign('RSA-SHA256')
    .update(buildEntitlementSigningPayload(snapshot), 'utf8')
    .sign(testKeys.privateKey, 'base64url')

  const dir = join(tmpConfigDir, 'subscription')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'entitlement-cache.json'),
    JSON.stringify({ snapshot: { ...snapshot, signature }, cachedAt: Date.now() }),
  )
}

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = tmpConfigDir
  process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM = testKeys.publicKey
  // 模拟 seedMarketingSkills 产物：bundle → 用户目录
  cpSync(bundledSkillsDir, join(tmpConfigDir, 'marketing-skills'), { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  delete process.env.PROMA_TEST_CONFIG_DIR
  delete process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

const slug = 'test-ws'

describe('marketing-skills-sync', () => {
  test('未订阅：不生成 .marketing-plugin（不默认带入）', () => {
    updateSettings({ marketingCapabilities: [] })
    syncMarketingSkillsForWorkspace(slug)
    expect(existsSync(getMarketingPluginDir(slug))).toBe(false)
  })

  test('订阅 influencer：分发 22 个 skill + plugin.json', () => {
    updateSettings({ marketingCapabilities: ['influencer'] })
    writeEntitlement(['influencer'])
    syncMarketingSkillsForWorkspace(slug)
    const skillsDir = join(getMarketingPluginDir(slug), 'skills')
    expect(existsSync(skillsDir)).toBe(true)
    expect(readdirSync(skillsDir).length).toBe(22)
    expect(readdirSync(skillsDir)).toContain('ma-kol-scraper')
    expect(readdirSync(skillsDir)).toContain('ma-pgy-invite')
    expect(existsSync(join(getMarketingPluginDir(slug), '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  test('切换到 paid-media：换域（22 → 16，influencer 独有被移除）', () => {
    updateSettings({ marketingCapabilities: ['paid-media'] })
    writeEntitlement(['paid-media'])
    syncMarketingSkillsForWorkspace(slug)
    const skillsDir = join(getMarketingPluginDir(slug), 'skills')
    const after = readdirSync(skillsDir)
    expect(after.length).toBe(16)
    expect(after).toContain('ma-campaign-optimizer')
    expect(after).not.toContain('ma-kol-scraper')
  })

  test('清空订阅：整体清理 .marketing-plugin（取消订阅即消失）', () => {
    updateSettings({ marketingCapabilities: [] })
    syncMarketingSkillsForWorkspace(slug)
    expect(existsSync(getMarketingPluginDir(slug))).toBe(false)
  })
})
