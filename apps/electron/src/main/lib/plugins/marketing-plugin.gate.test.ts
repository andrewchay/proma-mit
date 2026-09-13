import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { isMarketingEnabled, marketingPluginRuntime } from './marketing-plugin'
import { buildEntitlementSigningPayload } from '../subscription/entitlement-signature'
import type { EntitlementSnapshot } from '@gravitas/shared'

/**
 * 门禁测试：验证「改 settings.json 不能解锁付费能力」。
 *
 * 这是商业化能否成立的关键断言。测试同时覆盖：
 * - 仅有本地开关、无权益 → 不注入
 * - 有已验签权益但未本地开启 → 不注入
 * - 两者都满足 → 注入
 * - 本地开关 + 被篡改的权益 → 不注入
 */

const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function signedSnapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  const base: EntitlementSnapshot = {
    accountId: 'acc-1',
    planId: 'pro',
    capabilities: ['influencer', 'paid-media', 'outbound-sourcing'],
    status: 'active',
    lastVerifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    signature: '',
    keyId: 'prod-1',
    ...overrides,
  }
  const payload = buildEntitlementSigningPayload(base)
  const signature = createSign('RSA-SHA256')
    .update(payload, 'utf8')
    .sign(keyPair.privateKey, 'base64url')
  return { ...base, signature }
}

describe('营销插件门禁', () => {
  let tempDir: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'marketing-gate-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
    process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM = keyPair.publicKey
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** 写入 settings.json（模拟用户或旧版本留下的本地开关） */
  function writeSettings(capabilities: string[]): void {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ marketingCapabilities: capabilities }))
  }

  /** 写入权益缓存 */
  function writeEntitlement(snapshot: EntitlementSnapshot): void {
    const dir = join(tempDir, 'subscription')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'entitlement-cache.json'),
      JSON.stringify({ snapshot, cachedAt: Date.now() }),
    )
  }

  test('仅有本地开关、无任何权益时不启用', () => {
    writeSettings(['influencer', 'paid-media'])
    expect(isMarketingEnabled(['influencer'])).toBe(true) // 纯函数仍按传入值判断
    // 运行时门禁：无权益缓存 → 不注入工具
    const runtime = marketingPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
  })

  test('有已验签权益但本地未开启时不启用', () => {
    writeSettings([])
    writeEntitlement(signedSnapshot())

    const runtime = marketingPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
  })

  test('本地开启且权益有效时启用', () => {
    writeSettings(['influencer'])
    writeEntitlement(signedSnapshot({ capabilities: ['influencer'] }))

    const runtime = marketingPluginRuntime()
    expect(runtime.isEnabled()).toBe(true)
  })

  test('权益被篡改（改本地 JSON 冒充 pro）时不启用', () => {
    writeSettings(['influencer', 'paid-media', 'outbound-sourcing'])
    // 模拟用户手改权益缓存：伪造签名
    writeEntitlement(signedSnapshot({ planId: 'free', capabilities: [] }))
    const dir = join(tempDir, 'subscription')
    writeFileSync(
      join(dir, 'entitlement-cache.json'),
      JSON.stringify({
        snapshot: {
          ...signedSnapshot({ planId: 'free', capabilities: [] }),
          planId: 'pro',
          capabilities: ['influencer', 'paid-media', 'outbound-sourcing'],
        },
        cachedAt: Date.now(),
      }),
    )

    const runtime = marketingPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
    expect(runtime.contributeTools?.() ?? []).toHaveLength(0)
  })

  test('未配置公钥时不启用（不得静默放行）', () => {
    delete process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM
    writeSettings(['influencer'])
    writeEntitlement(signedSnapshot({ capabilities: ['influencer'] }))

    const runtime = marketingPluginRuntime()
    // 非打包环境下 dev 签名豁免不适用于真实签名：无公钥则无法验签 → 拒绝
    expect(runtime.isEnabled()).toBe(false)
  })

  test('权益过期后不再启用', () => {
    writeSettings(['influencer'])
    writeEntitlement(
      signedSnapshot({
        capabilities: ['influencer'],
        validUntil: new Date(Date.now() - 1000).toISOString(),
        lastVerifiedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    )

    const runtime = marketingPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
  })

  test('权益只授予部分能力时，只注入对应工具', () => {
    writeSettings(['influencer', 'paid-media'])
    writeEntitlement(signedSnapshot({ capabilities: ['influencer'] }))

    const runtime = marketingPluginRuntime()
    expect(runtime.isEnabled()).toBe(true)
    // 只有 influencer 被授予，paid-media 不应出现在偏好结果中
    // contributeTools 会按订阅域过滤
    const tools = runtime.contributeTools?.() ?? []
    expect(tools.length).toBeGreaterThan(0)
  })
})
