import { describe, expect, test } from 'bun:test'
import { collectContributingTools, collectContributingPrompts, _resetPluginManagerForTests } from '../plugin-manager'
import { marketingPluginRuntime, isMarketingEnabled, allMarketingToolDefinitions, contributePromptsForSubscribed } from './marketing-plugin'

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
    // 本地 storyboard 永远存在。此断言保证降级不吞掉本地工具。
    const tools = runtime.contributeTools?.() ?? []
    expect(tools.length).toBeGreaterThanOrEqual(1)
    expect(tools.map((t) => t.name)).toContain('ma_generate_storyboard')
  })

  test('ma_generate_storyboard 纯本地可完整执行（无需凭据/LLM）', async () => {
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
    const tools = runtime.contributeTools?.() ?? []
    const storyboardTool = tools.find((t) => t.name === 'ma_generate_storyboard')
    expect(storyboardTool).toBeDefined()

    const result = await storyboardTool!.execute({ product: '', category: '', platform: '', text_input: '' }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('必填')
  })

  test('collectContributingTools 经 BUILTIN_RUNTIMES 收集到营销本地工具', () => {
    _resetPluginManagerForTests()
    const tools = collectContributingTools()
    // 内置插件含 marketing（isEnabled 恒 true、平台全支持）
    expect(tools.map((t) => t.name)).toContain('ma_generate_storyboard')
    _resetPluginManagerForTests()
  })

  test('contributePrompts 按默认订阅(influencer)贡献达人域指令', () => {
    const prompts = runtime.contributePrompts?.() ?? []
    // 默认订阅 influencer：达人域 8 条指令（storyboard 无指令）
    expect(prompts.length).toBeGreaterThanOrEqual(8)
    // 均为领域能力引导文本
    for (const p of prompts) {
      expect(typeof p).toBe('string')
      expect(p.length).toBeGreaterThan(20)
    }
  })

  test('collectContributingPrompts 经 BUILTIN_RUNTIMES 收集到营销指令（按默认订阅影响）', () => {
    _resetPluginManagerForTests()
    const prompts = collectContributingPrompts()
    // 默认订阅 influencer：达人域指令存在，投放域指令被过滤
    expect(prompts.some((p) => p.includes('MAKOL搜索'))).toBe(true)
    expect(prompts.some((p) => p.includes('MA达人CRM'))).toBe(true)
    expect(prompts.some((p) => p.includes('MA策略生成'))).toBe(false)
    _resetPluginManagerForTests()
  })

  test('isMarketingEnabled 依据订阅状态判定启用', () => {
    // 未设置（undefined）→ 默认启用
    expect(isMarketingEnabled(undefined)).toBe(true)
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
