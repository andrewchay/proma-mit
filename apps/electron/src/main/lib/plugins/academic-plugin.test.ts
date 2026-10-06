import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { academicPluginRuntime, hasAcademicEntitlement, TOOL_NAMES } from './academic-plugin'
import { buildEntitlementSigningPayload } from '../subscription/entitlement-signature'
import type { EntitlementSnapshot } from '@gravitas/shared'

/**
 * 学术助手插件门禁测试。
 *
 * 学术助手是付费插件，因此「改本地配置不能解锁工具」这一断言
 * 必须成立。测试覆盖：
 * - 无权益 → 不注入工具
 * - 已验签且授予 academic → 注入工具
 * - 权益被篡改 → 不注入
 * - 未配置公钥 → 不启用（不得静默放行）
 * - 权益过期 → 不启用
 * - 权益未授予 academic（只授予营销）→ 不注入
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
    capabilities: ['academic'],
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

describe('学术助手插件门禁', () => {
  let tempDir: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'academic-gate-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
    process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM = keyPair.publicKey
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** 写入权益缓存 */
  function writeEntitlement(snapshot: EntitlementSnapshot): void {
    const dir = join(tempDir, 'subscription')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'entitlement-cache.json'),
      JSON.stringify({ snapshot, cachedAt: Date.now() }),
    )
  }

  /** 写入 settings.json（模拟用户留下的本地开关） */
  function writeSettings(domainCapabilities: string[]): void {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({ domainCapabilities }))
  }

  test('无权益缓存时不启用，也不注入工具', () => {
    writeSettings(['academic'])
    const runtime = academicPluginRuntime()
    expect(hasAcademicEntitlement()).toBe(false)
    expect(runtime.isEnabled()).toBe(false)
    expect(runtime.contributeTools?.() ?? []).toHaveLength(0)
    expect(runtime.contributePrompts?.() ?? []).toHaveLength(0)
  })

  test('权益有效且授予 academic 时启用并注入全部工具', () => {
    writeEntitlement(signedSnapshot())
    const runtime = academicPluginRuntime()
    expect(runtime.isEnabled()).toBe(true)

    const tools = runtime.contributeTools?.() ?? []
    expect(tools).toHaveLength(TOOL_NAMES.length)
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())

    const prompts = runtime.contributePrompts?.() ?? []
    expect(prompts.length).toBeGreaterThan(0)
  })

  test('权益被篡改（手改 JSON 冒充 pro）时不启用', () => {
    const dir = join(tempDir, 'subscription')
    mkdirSync(dir, { recursive: true })
    // 基础快照签名来自 capabilities: []，随后被改成 ['academic']
    writeFileSync(
      join(dir, 'entitlement-cache.json'),
      JSON.stringify({
        snapshot: {
          ...signedSnapshot({ planId: 'free', capabilities: [] }),
          planId: 'pro',
          capabilities: ['academic'],
        },
        cachedAt: Date.now(),
      }),
    )

    const runtime = academicPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
    expect(runtime.contributeTools?.() ?? []).toHaveLength(0)
  })

  test('未配置公钥时不启用（不得静默放行）', () => {
    delete process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM
    writeEntitlement(signedSnapshot())

    const runtime = academicPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
  })

  test('权益过期后不再启用', () => {
    writeEntitlement(
      signedSnapshot({
        validUntil: new Date(Date.now() - 1000).toISOString(),
        lastVerifiedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    )

    const runtime = academicPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
  })

  test('权益未授予 academic（只授予营销）时不注入工具', () => {
    writeEntitlement(signedSnapshot({ capabilities: ['influencer', 'paid-media'] }))

    const runtime = academicPluginRuntime()
    expect(runtime.isEnabled()).toBe(false)
    expect(runtime.contributeTools?.() ?? []).toHaveLength(0)
  })

  test('完整性检查工具在缺少 text 时返回错误而非抛异常', async () => {
    writeEntitlement(signedSnapshot())
    const runtime = academicPluginRuntime()
    const tool = (runtime.contributeTools?.() ?? []).find((t) => t.name === 'academic_check_integrity')
    expect(tool).toBeDefined()

    const result = await tool!.execute({}, { cwd: tempDir, sessionId: 'test-session' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('text 不能为空')
  })

  test('完整性检查工具能对真实文本产出报告', async () => {
    writeEntitlement(signedSnapshot())
    const runtime = academicPluginRuntime()
    const tool = (runtime.contributeTools?.() ?? []).find((t) => t.name === 'academic_check_integrity')

    const result = await tool!.execute(
      { text: '我们提出了一种新方法，实验表明其优于基线。参考文献 [1] 指出该方法有效。' },
      { cwd: tempDir, sessionId: 'test-session' },
    )
    expect(result.isError).toBeFalsy()
    const report = JSON.parse(result.content) as { paperId: string; overallScore: number }
    expect(report.paperId).toBe('adhoc')
    expect(typeof report.overallScore).toBe('number')
  })

  test('评审模拟工具在 sections 为空时返回错误', async () => {
    writeEntitlement(signedSnapshot())
    const runtime = academicPluginRuntime()
    const tool = (runtime.contributeTools?.() ?? []).find((t) => t.name === 'academic_simulate_peer_review')

    const result = await tool!.execute(
      { title: '测试论文', sections: [] },
      { cwd: tempDir, sessionId: 'test-session' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('sections 不能为空')
  })

  test('论文项目工具在无数据时返回空列表而非抛错', async () => {
    writeEntitlement(signedSnapshot())
    const runtime = academicPluginRuntime()
    const tool = (runtime.contributeTools?.() ?? []).find((t) => t.name === 'academic_list_papers')

    const result = await tool!.execute({}, { cwd: tempDir, sessionId: 'test-session' })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content)).toEqual([])
  })
})

describe('学术助手插件 manifest', () => {
  test('声明正确的插件 id 与 surface', () => {
    const runtime = academicPluginRuntime()
    expect(runtime.manifest.id).toBe('com.gravitas.academic')
    expect(runtime.manifest.surfaces).toContain('agent-tools')
    expect(runtime.manifest.platforms).toContain('darwin')
  })

  test('工具名使用 academic_ 前缀且无重名', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length)
    for (const name of TOOL_NAMES) {
      expect(name.startsWith('academic_')).toBe(true)
    }
  })
})

/**
 * 调试放开：这是唯一一条「不构造权益快照也能使用付费插件」的路径，
 * 因此必须同时验证它确实生效、且只在显式开关下生效。
 */
describe('学术助手插件 · 调试放开', () => {
  const originalEnv = { ...process.env }
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'academic-unlock-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
    delete process.env.GRAVITAS_UNLOCK_ALL_CAPABILITIES
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('未设置开关时无权益即不启用', () => {
    expect(hasAcademicEntitlement()).toBe(false)
  })

  test('设置开关后无权益也授予 academic 并注入工具', () => {
    process.env.GRAVITAS_UNLOCK_ALL_CAPABILITIES = '1'

    expect(hasAcademicEntitlement()).toBe(true)
    const runtime = academicPluginRuntime()
    expect(runtime.isEnabled()).toBe(true)
    expect((runtime.contributeTools?.() ?? []).length).toBeGreaterThan(0)
  })
})
