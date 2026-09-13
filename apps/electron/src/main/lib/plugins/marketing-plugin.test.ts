import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { collectContributingTools, collectContributingPrompts, collectContributingSkills, _resetPluginManagerForTests } from '../plugin-manager'
import { marketingPluginRuntime, isMarketingEnabled, allMarketingToolDefinitions, contributePromptsForSubscribed } from './marketing-plugin'
import { updateSettings } from '../settings-service'
import { buildEntitlementSigningPayload } from '../subscription/entitlement-signature'
import type { EntitlementSnapshot } from '@gravitas/shared'

/**
 * 本测试避免写真实 ~/.proma。需要驱动营销订阅状态时，
 * 用临时 PROMA_TEST_CONFIG_DIR 隔离并在测试后清理。
 *
 * 商业化后的权限模型：本地 settings 开关只是偏好，
 * 实际注入还需已验签的订阅权益。因此需要驱动运行时注入的测试，
 * 必须先调用 grantEntitlement 授予权益。
 */
const tmpConfigDir = mkdtempSync(join(tmpdir(), 'gravitas-marketing-test-'))
const bundledMarketingToolsDir = join(import.meta.dir, '../../../../default-tools/marketing')

const testKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

/** 写入已验签的权益快照，模拟用户已订阅专业版 */
function grantEntitlement(capabilities: string[]): void {
  const snapshot: EntitlementSnapshot = {
    accountId: 'test-account',
    planId: 'pro',
    capabilities: capabilities as EntitlementSnapshot['capabilities'],
    status: 'active',
    lastVerifiedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    signature: '',
    keyId: 'test-1',
  }
  const payload = buildEntitlementSigningPayload(snapshot)
  const signature = createSign('RSA-SHA256')
    .update(payload, 'utf8')
    .sign(testKeys.privateKey, 'base64url')

  const dir = join(tmpConfigDir, 'subscription')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'entitlement-cache.json'),
    JSON.stringify({ snapshot: { ...snapshot, signature }, cachedAt: Date.now() }),
  )
}

/** 清除权益，模拟未订阅 */
function revokeEntitlement(): void {
  const path = join(tmpConfigDir, 'subscription', 'entitlement-cache.json')
  rmSync(path, { force: true })
}

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = tmpConfigDir
  process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM = testKeys.publicKey
  cpSync(bundledMarketingToolsDir, join(tmpConfigDir, 'default-tools', 'marketing'), { recursive: true })
})
afterAll(async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  delete process.env.PROMA_TEST_CONFIG_DIR
  delete process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM
  rmSync(tmpConfigDir, { recursive: true, force: true })
})


describe('Marketing 插件', () => {
  const runtime = marketingPluginRuntime()

  test('manifest 声明 agent-tools surface 与本地能力定位', () => {
    expect(runtime.manifest.id).toBe('com.gravitas.marketing')
    expect(runtime.manifest.surfaces).toContain('agent-tools')
    // 营销工具仅调用本地 LLM + 本地 SQLite，不声明任何高特权权限
    expect(runtime.manifest.permissions).not.toHaveProperty('computerUse')
    expect(runtime.manifest.permissions).not.toHaveProperty('overlay')
  })

  test('contributeTools 至少贡献本地 storyboard 工具（纯本地恒在）', () => {
    // 商业化契约：注入需已验签权益。storyboard 属于 shared，随任一业务包启用。
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    const tools = runtime.contributeTools?.() ?? []
    const names = tools.map((t) => t.name)
    expect(names).toContain('ma_generate_storyboard')
    // 每个工具都带可执行函数（「可调用」而非「孤儿 ChatToolMeta」的关键）
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function')
      expect(tool.parameters).toHaveProperty('type', 'object')
    }
  })

  test('本地工具恒被贡献（依赖 electron 的 ma-tool 在纯 bun test 下容错降级）', () => {
    // 在非 electron 环境，依赖 LLM/electron 的 ma-tool 被 try/catch 降级；
    // 本地 storyboard 仍存在。此断言保证降级不吞掉本地工具。
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    const tools = runtime.contributeTools?.() ?? []
    expect(tools.length).toBeGreaterThanOrEqual(1)
    expect(tools.map((t) => t.name)).toContain('ma_generate_storyboard')
  })

  test('ma_generate_storyboard 纯本地可完整执行（无需凭据/LLM）', async () => {
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    const tools = runtime.contributeTools?.() ?? []
    const storyboardTool = tools.find((t) => t.name === 'ma_generate_storyboard')
    expect(storyboardTool).toBeDefined()

    const result = await storyboardTool!.execute(
      {
        product: '智能保温杯',
        category: '日用消费品',
        selling_points: '持久保温,轻量便携',
        target_audience: '都市白领',
        platform: 'douyin',
        duration: 30,
        text_input: '为一款智能保温杯生成投放抖音的广告分镜',
      },
      {} as never,
    )
    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('分镜')
    expect(result.content).toContain('镜头')
    expect(result.content).toContain('旁白')
  })

  test('ma_generate_storyboard 必填参数缺失时返回错误', async () => {
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    const tools = runtime.contributeTools?.() ?? []
    const storyboardTool = tools.find((t) => t.name === 'ma_generate_storyboard')
    expect(storyboardTool).toBeDefined()

    const result = await storyboardTool!.execute({ product: '', category: '', platform: '', text_input: '' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('必填')
  })

  test('collectContributingTools 默认不收集营销工具，订阅后收集', () => {
    _resetPluginManagerForTests()
    // 显式清除可能被前序测试遗留的权益缓存，保证本用例从「未订阅」状态开始
    revokeEntitlement()
    updateSettings({ marketingCapabilities: [] })
    // 未订阅任何领域包 → 营销 isEnabled false → 不收集营销工具
    const toolsOff = collectContributingTools()
    expect(toolsOff.map((t) => t.name)).not.toContain('ma_generate_storyboard')
    _resetPluginManagerForTests()

    // 订阅 influencer 后 → 营销启用 → 收集到 shared storyboard + 达人域工具
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    try {
      const toolsOn = collectContributingTools()
      expect(toolsOn.map((t) => t.name)).toContain('ma_generate_storyboard')
      expect(toolsOn.map((t) => t.name)).toContain('ma_search_kols')
    } finally {
      updateSettings({ marketingCapabilities: [] })
    revokeEntitlement()
      _resetPluginManagerForTests()
    }
  })
  test('Given 已目录化营销工具 When 切换订阅 Then Runtime 仅注入对应子域且不重复', () => {
    _resetPluginManagerForTests()
    updateSettings({ marketingCapabilities: [] })
    revokeEntitlement()
    expect(collectContributingTools().some((tool) => tool.name.startsWith('ma_'))).toBe(false)

    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    const influencerTools = collectContributingTools().map((tool) => tool.name)
    expect(influencerTools).toEqual(expect.arrayContaining([
      'ma_generate_storyboard', 'ma_generate_outreach', 'ma_kol_crm', 'ma_kol_portal', 'ma_generate_script',
    ]))
    expect(influencerTools).not.toContain('ma_design_campaign_test')
    expect(influencerTools).not.toContain('ma_campaign_update')

    updateSettings({ marketingCapabilities: ['paid-media'] })
    grantEntitlement(['paid-media'])
    const paidMediaTools = collectContributingTools().map((tool) => tool.name)
    expect(paidMediaTools).toEqual(expect.arrayContaining([
      'ma_generate_storyboard', 'ma_design_campaign_test', 'ma_campaign_update', 'ma_campaign_brief_get',
      'ma_campaign_kol_status', 'ma_analyze_content_performance', 'ma_suggest_traffic_strategy',
    ]))
    expect(paidMediaTools).not.toContain('ma_generate_outreach')
    expect(paidMediaTools).not.toContain('ma_kol_crm')

    updateSettings({ marketingCapabilities: ['influencer', 'paid-media'] })
    grantEntitlement(['influencer', 'paid-media'])
    const allNames = collectContributingTools().map((tool) => tool.name)
    expect(allNames.filter((name) => name.startsWith('ma_'))).toHaveLength(26)
    expect(new Set(allNames).size).toBe(allNames.length)

    const prompts = collectContributingPrompts().join('\n')
    expect(prompts).toContain('MAKOL搜索')
    expect(prompts).toContain('MA策略生成')

    updateSettings({ marketingCapabilities: [] })
    revokeEntitlement()
    _resetPluginManagerForTests()
  })

  test('contributePrompts 订阅 influencer 后贡献达人域指令', () => {
    // 默认未订阅 → 无营销指令
    const promptsOff = runtime.contributePrompts?.() ?? []
    expect(promptsOff.length).toBe(0)

    // 订阅 influencer 后 → 达人域指令存在且为领域引导文本
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    try {
      const prompts = runtime.contributePrompts?.() ?? []
      expect(prompts.length).toBeGreaterThanOrEqual(8)
      for (const p of prompts) {
        expect(typeof p).toBe('string')
        expect(p.length).toBeGreaterThan(20)
      }
    } finally {
      updateSettings({ marketingCapabilities: [] })
    revokeEntitlement()
    }
  })

  test('collectContributingPrompts 订阅 influencer 后收集达人域指令并过滤投放域', () => {
    _resetPluginManagerForTests()
    // 默认未订阅 → 无营销指令
    expect(collectContributingPrompts().some((p) => p.includes('MAKOL搜索'))).toBe(false)
    _resetPluginManagerForTests()

    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    try {
      const prompts = collectContributingPrompts()
      expect(prompts.some((p) => p.includes('MAKOL搜索'))).toBe(true)
      expect(prompts.some((p) => p.includes('MA达人CRM'))).toBe(true)
      expect(prompts.some((p) => p.includes('MA策略生成'))).toBe(false)
    } finally {
      updateSettings({ marketingCapabilities: [] })
    revokeEntitlement()
      _resetPluginManagerForTests()
    }
  })

  test('isMarketingEnabled 依据订阅状态判定启用', () => {
    // 未设置（undefined）→ 默认不启用
    expect(isMarketingEnabled(undefined)).toBe(false)
    // 有订阅业务包 → 启用
    expect(isMarketingEnabled(['influencer'])).toBe(true)
    expect(isMarketingEnabled(['paid-media'])).toBe(true)
    // 空数组（用户取消全部订阅）→ 不启用 → 营销工具与指令不注入
    expect(isMarketingEnabled([])).toBe(false)
  })

  test('按订阅细分注入：influencer 只注入达人域 + shared storyboard', () => {
    const tools = allMarketingToolDefinitions(['influencer'])
    const names = tools.map((t) => t.name)
    // shared storyboard 恒在
    expect(names).toContain('ma_generate_storyboard')
    // influencer 域工具（纯 SQLite 可 require）
    expect(names).toContain('ma_search_kols')
    // paid-media 域工具（ma_generate_phase_report 纯本地可 require）—— 应被过滤
    expect(names).not.toContain('ma_generate_phase_report')
  })

  test('按订阅细分注入：paid-media 只注入投放域 + shared storyboard', () => {
    const tools = allMarketingToolDefinitions(['paid-media'])
    const names = tools.map((t) => t.name)
    expect(names).toContain('ma_generate_storyboard')
    expect(names).toContain('ma_generate_phase_report')
    // influencer 域工具应被过滤
    expect(names).not.toContain('ma_search_kols')
  })

  test('按订阅细分注入：同时订阅两域则注入全部', () => {
    const tools = allMarketingToolDefinitions(['influencer', 'paid-media'])
    const names = tools.map((t) => t.name)
    expect(names).toContain('ma_generate_storyboard')
    expect(names).toContain('ma_search_kols')
    expect(names).toContain('ma_generate_phase_report')
  })

  test('指令也按订阅细分过滤', () => {
    const influencerPrompts = contributePromptsForSubscribed(['influencer'])
    const influencerText = influencerPrompts.join('\n')
    // influencer 域指令存在
    expect(influencerText).toContain('MAKOL搜索')
    expect(influencerText).toContain('MA达人CRM')
    // paid-media 域指令被过滤
    expect(influencerText).not.toContain('MA策略生成')
    expect(influencerText).not.toContain('MA预算预估')

    const paidPrompts = contributePromptsForSubscribed(['paid-media'])
    const paidText = paidPrompts.join('\n')
    expect(paidText).toContain('MA策略生成')
    expect(paidText).toContain('MA预算预估')
    expect(paidText).not.toContain('MAKOL搜索')
  })
})


describe('Marketing 插件 Skills 贡献（surface: agent-skills）', () => {
  const runtime = marketingPluginRuntime()
  const bundledMarketingSkillsDir = join(import.meta.dir, '../../../../marketing-skills')

  beforeAll(() => {
    // 把源码 marketing-skills 同步到测试配置目录，模拟 seedMarketingSkills 的产物
    cpSync(bundledMarketingSkillsDir, join(tmpConfigDir, 'marketing-skills'), { recursive: true })
  })

  test('manifest 声明 agent-skills surface', () => {
    expect(runtime.manifest.surfaces).toContain('agent-skills')
  })

  test('未订阅时 contributeSkills 返回空（不默认带入新建项目）', () => {
    updateSettings({ marketingCapabilities: [] })
    revokeEntitlement()
    expect(runtime.contributeSkills?.()).toEqual([])
    expect(collectContributingSkills()).toEqual([])
  })

  test('订阅 influencer 后贡献达人域(11) + shared(11) = 22 个 skill', () => {
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    const skills = runtime.contributeSkills?.() ?? []
    expect(skills.length).toBe(22)
    const slugs = skills.map((s) => s.slug)
    expect(slugs).toContain('ma-kol-scraper')
    expect(slugs).toContain('ma-pgy-invite')
    expect(slugs).toContain('ma-marketing') // shared 总纲
    expect(slugs).not.toContain('ma-paid-media')
    // 每个 skill 目录真实存在且带域标记
    for (const s of skills) {
      expect(s.domain).toBeTruthy()
      expect(s.version).not.toBe('0.0.0')
    }
  })

  test('订阅 paid-media 后贡献投放域(5) + shared(11) = 16 个 skill', () => {
    updateSettings({ marketingCapabilities: ['paid-media'] })
    grantEntitlement(['paid-media'])
    const skills = runtime.contributeSkills?.() ?? []
    expect(skills.length).toBe(16)
    const slugs = skills.map((s) => s.slug)
    expect(slugs).toContain('ma-campaign-optimizer')
    expect(slugs).not.toContain('ma-draft-review')
    expect(slugs).not.toContain('ma-kol-scraper')
  })

  test('collectContributingSkills 与 runtime 贡献一致', () => {
    updateSettings({ marketingCapabilities: ['influencer'] })
    grantEntitlement(['influencer'])
    expect(collectContributingSkills().length).toBe(22)
  })
})
