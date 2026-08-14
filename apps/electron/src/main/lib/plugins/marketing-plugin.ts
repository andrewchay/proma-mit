/**
 * Marketing 插件（com.gravitas.marketing）
 *
 * 把营销领域的 ma-* 工具族（内容审核 / 视频分镜 / 策略 / 达人 / 投放等）以「插件贡献
 * agent-tools」的方式提供，替代原先游离在 ma-tools 中、无消费方的 ChatToolMeta 定义。
 *
 * 设计要点：
 * - 用一个通用适配器 `toRuntimeTool` 把既有 ma-tool 模块（TOOL_DEFINITIONS + executeXxxTool）
 *   转成 agent-runtime 的 RuntimeToolDefinition，避免逐工具手写 schema/execute 包装。
 * - 所有 ma-tool 模块通过「延迟 require」加载：多数工具依赖 llm-service→channel-manager
 *   （用 electron safeStorage 解密 key），只能在 Electron 主进程运行。纯本地工具
 *   （kOL 数据 / 分镜）在任意环境可用；依赖 electron 的在非 electron 环境被 try/catch 安全降级跳过。
 * - manifest.permissions：营销工具仅调用本地 LLM + 本地 SQLite，无宿主持权能力，不声明高特权权限。
 */
import type { RuntimeToolDefinition } from '../agent-runtime/types'
import type { BuiltinPluginRuntime } from '../plugin-manager'
import type { ToolCall, ToolDefinition, ToolResult } from '@gravitas/core'
import {
  generateStoryboard,
  type Storyboard,
  type VideoInput,
} from '../marketing/video/storyboard-engine'
import { MA_TOOL_SYSTEM_PROMPTS } from '../marketing/ma-tools/ma-tool-prompts'

// =====================================================================
// 通用适配器：ma 工具 → RuntimeToolDefinition
// =====================================================================

/** ma-tool 的 execute 签名（与既有 executeXxxTool(toolCall) 一致） */
type MaExecute = (toolCall: ToolCall) => Promise<ToolResult>

/**
 * 把既有 MaTool 模块（ToolDefinition[] + execute）转成 RuntimeToolDefinition。
 *
 * agent-runtime 约定 execute 返回 `toolCallId: ''`（由运行时回填）；ma 工具内部
 * 回填 `toolCall.id`，此处在包装时传 `id: ''`，使两边约定天然一致。
 */
function toRuntimeTool(def: ToolDefinition, execute: MaExecute): RuntimeToolDefinition {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (input) =>
      execute({ id: '', name: def.name, arguments: (input ?? {}) as Record<string, unknown> }),
  }
}

/**
 * 声明式「延迟加载的 ma-tool 模块」。
 *
 * 返回一个工厂：调用时才 require（避免模块顶层加载 electron 链）。
 * 每个 ma-tool 模块导出其 `TOOL_DEFINITIONS`（完整 JSON Schema）与 `executeXxxTool`，
 * 经 toRuntimeTool 统一转 runtime 工具。
 */
function lazyMaTools(relPath: string, defsKey: string, execKey: string): () => RuntimeToolDefinition[] {
  return () => {
    const mod = require(relPath) as Record<string, unknown>
    const defs = mod[defsKey] as ToolDefinition[]
    const execute = mod[execKey] as MaExecute
    if (!Array.isArray(defs) || typeof execute !== 'function') return []
    return defs.map((def) => toRuntimeTool(def, execute))
  }
}

// =====================================================================
// 本地工具（纯本地、零 electron 依赖，可顶层构造 / 测试可执行）
// =====================================================================

/** 营销视频分镜生成工具（纯本地，无需凭据；storyboard-engine 零依赖） */
function marketingGenerateStoryboardTool(): RuntimeToolDefinition {
  return {
    name: 'ma_generate_storyboard',
    description:
      '为品牌/产品生成广告视频分镜脚本（shot by shot：画面描述、镜头运动、旁白、字幕、视频生成提示词），纯本地、无需视频引擎凭据。当用户需要为投放/达人内容制定视频分镜脚本时使用。',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: '产品/服务名称' },
        category: { type: 'string', description: '品类' },
        selling_points: { type: 'string', description: '核心卖点（逗号分隔，如 "持久续航,轻量便携"）' },
        target_audience: { type: 'string', description: '目标人群' },
        platform: { type: 'string', enum: ['xiaohongshu', 'douyin', 'bilibili', 'weibo'], description: '投放平台' },
        duration: { type: 'number', description: '目标时长（秒）' },
        style: { type: 'string', description: '风格偏好（可选）' },
        text_input: { type: 'string', description: '原始输入文本' },
      },
      required: ['product', 'category', 'platform', 'text_input'],
    },
    execute: async (input) => {
      const args = (input ?? {}) as Record<string, unknown>
      const product = String(args.product ?? '').trim()
      const category = String(args.category ?? '').trim()
      const platform = String(args.platform ?? '').trim()
      const textInput = String(args.text_input ?? '').trim()

      if (!product || !category || !platform || !textInput) {
        return { toolCallId: '', content: '参数缺失: product、category、platform、text_input 为必填项', isError: true }
      }

      const sellingPoints = typeof args.selling_points === 'string'
        ? args.selling_points.split(',').map((s) => s.trim()).filter(Boolean)
        : []

      const videoInput: VideoInput = {
        product,
        category,
        sellingPoints,
        targetAudience: String(args.target_audience ?? ''),
        platform: platform as VideoInput['platform'],
        duration: typeof args.duration === 'number' ? args.duration : 30,
        style: typeof args.style === 'string' ? args.style : undefined,
        textInput,
      }

      const storyboard: Storyboard = generateStoryboard(videoInput)

      const lines = [
        `# ${product} 广告分镜脚本（${storyboard.totalShots} 镜 · ${storyboard.totalDuration}s）`,
        `创意方向: ${storyboard.creativeDirection}`,
        `推荐引擎: ${storyboard.recommendedEngine}`,
        '',
        ...storyboard.shots.map((shot) => [
          `--- 镜 ${shot.shotId} [${shot.timeRange}] ---`,
          `场景: ${shot.scene}`,
          `画面: ${shot.visualDescription}`,
          `镜头运动: ${shot.camera}`,
          `旁白: ${shot.narration}`,
          `字幕: ${shot.subtitle}`,
          `生成方式: ${shot.generationMethod}`,
          `首帧提示词: ${shot.firstFramePrompt}`,
          `视频提示词: ${shot.videoPrompt}`,
        ].join('\n')),
      ].join('\n')

      return { toolCallId: '', content: lines }
    },
  }
}

// =====================================================================
// ma-tool 声明式清单（延迟加载，容错降级），按领域子域分组
// =====================================================================

/** 营销工具所属领域子域：influencer(达人) / paid-media(投放) / shared(随任一订阅启用) */
export type MarketingToolDomain = 'influencer' | 'paid-media' | 'shared'

interface MarketingToolGroup {
  domain: MarketingToolDomain
  factories: Array<() => RuntimeToolDefinition[]>
}

const MA_TOOL_GROUPS: MarketingToolGroup[] = [
  // —— 达人 influencer ——
  {
    domain: 'influencer',
    factories: [
      lazyMaTools('../marketing/ma-tools/match-ai', 'MATCH_AI_TOOL_DEFINITIONS', 'executeMatchAITool'),
      lazyMaTools('../marketing/ma-tools/connect-bot', 'CONNECT_BOT_TOOL_DEFINITIONS', 'executeConnectBotTool'),
      lazyMaTools('../marketing/ma-tools/creative-pilot', 'CREATIVE_PILOT_TOOL_DEFINITIONS', 'executeCreativePilotTool'),
      lazyMaTools('../marketing/ma-tools/kol-search', 'KOL_SEARCH_TOOL_DEFINITIONS', 'executeKOLSearchTool'),
      lazyMaTools('../marketing/ma-tools/kol-crm', 'KOL_CRM_TOOL_DEFINITIONS', 'executeKOLCRMTool'),
      lazyMaTools('../marketing/ma-tools/kol-portal', 'KOL_PORTAL_TOOL_DEFINITIONS', 'executeKOLPortalTool'),
      lazyMaTools('../marketing/ma-tools/content-audit', 'CONTENT_AUDIT_TOOL_DEFINITIONS', 'executeContentAuditTool'),
      lazyMaTools('../marketing/ma-tools/script-studio', 'SCRIPT_STUDIO_TOOL_DEFINITIONS', 'executeScriptStudioTool'),
    ],
  },
  // —— 广告投放 paid-media ——
  {
    domain: 'paid-media',
    factories: [
      lazyMaTools('../marketing/ma-tools/strategy-iq', 'STRATEGY_IQ_TOOL_DEFINITIONS', 'executeStrategyIQTool'),
      lazyMaTools('../marketing/ma-tools/campaign-agent', 'CAMPAIGN_AGENT_TOOL_DEFINITIONS', 'executeCampaignAgentTool'),
      lazyMaTools('../marketing/ma-tools/campaign-optimizer', 'CAMPAIGN_OPTIMIZER_TOOL_DEFINITIONS', 'executeCampaignOptimizerTool'),
      lazyMaTools('../marketing/ma-tools/campaign-tester', 'CAMPAIGN_TESTER_TOOL_DEFINITIONS', 'executeCampaignTesterTool'),
      lazyMaTools('../marketing/ma-tools/budget-forecast', 'BUDGET_FORECAST_TOOL_DEFINITIONS', 'executeBudgetForecastTool'),
      lazyMaTools('../marketing/ma-tools/content-tracker', 'CONTENT_TRACKER_TOOL_DEFINITIONS', 'executeContentTrackerTool'),
      lazyMaTools('../marketing/ma-tools/ma-phase-reviewer', 'PHASE_REVIEWER_TOOL_DEFINITIONS', 'executePhaseReviewerTool'),
    ],
  },
]

/** 依据订阅集合，计算需注入的领域子域集合（shared 固定包含，随任一订阅启用） */
function subscribedDomains(subscribed: string[]): Set<MarketingToolDomain> {
  const caps = subscribed.length > 0 ? subscribed : [...DEFAULT_ENABLED_CAPABILITIES]
  const domains = new Set<MarketingToolDomain>(['shared'])
  if (caps.includes('influencer')) domains.add('influencer')
  if (caps.includes('paid-media')) domains.add('paid-media')
  return domains
}

/** 按订阅注入的工具定义：仅返回订阅命中的领域（shared 固定）的 ma-tool + 本地 storyboard */
export function allMarketingToolDefinitions(subscribed: string[]): RuntimeToolDefinition[] {
  const domains = subscribedDomains(subscribed)
  const tools: RuntimeToolDefinition[] = []
  // shared：storyboard（素材/分镜，随任一业务包启用）
  if (domains.has('shared')) {
    tools.push(marketingGenerateStoryboardTool())
  }
  for (const group of MA_TOOL_GROUPS) {
    if (!domains.has(group.domain)) continue
    for (const factory of group.factories) {
      try {
        tools.push(...factory())
      } catch {
        // 非 Electron 环境（bun test 等）或依赖缺失：该 ma-tool 降级跳过，不影响其余工具。
      }
    }
  }
  return tools
}

/** 按订阅注入的指令：仅返回订阅命中的领域对应的工具引导指令 */
export function contributePromptsForSubscribed(subscribed: string[]): string[] {
  const domains = subscribedDomains(subscribed)
  return MA_TOOL_SYSTEM_PROMPTS
    .filter((entry) => domains.has(entry.domain))
    .map((entry) => entry.prompt)
}

// =====================================================================
// 订阅判定
// =====================================================================

/** 默认订阅（未设置时保持现状：默认启用 influencer） */
export const DEFAULT_ENABLED_CAPABILITIES: readonly string[] = ['influencer']

/**
 * 依据营销订阅状态判定营销能力是否启用。
 * - 空数组或未订阅任何业务包 → false（不注入营销工具与指令）
 * - 未设置（undefined）→ 回退默认，true
 */
export function isMarketingEnabled(caps?: string[]): boolean {
  return (caps ?? DEFAULT_ENABLED_CAPABILITIES).length > 0
}

// =====================================================================
// 插件运行时
// =====================================================================

/** Marketing 插件运行时（作为内置插件被 plugin-manager 管理） */
export function marketingPluginRuntime(): BuiltinPluginRuntime {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.gravitas.marketing',
      version: '0.2.0',
      name: '营销应用中心',
      description: '提供营销领域 Agent 工具（内容审核 / 视频分镜 / 策略 / 达人 / 投放），驱动应用中心的能力落地',
      publisher: 'Proma',
      platforms: ['darwin', 'win32', 'linux'],
      activationEvents: ['onAppReady'],
      subscriptions: [],
      surfaces: ['agent-tools'],
      permissions: {
        // 营销工具仅调用本地 LLM + 本地 SQLite，无宿主持权能力。
        // 网络/存储等高风险权限保持「默认禁止」不在此声明。
      },
      entrypoints: {},
    },
    isEnabled: () => isMarketingEnabled(readSubscribedCapabilities()),
    setEnabled: async () => true,
    isSupported: () => true,
    // 向 Agent 注入营销工具（按订阅的领域子域过滤；storyboard/shared 随任一订阅启用）
    contributeTools: () => allMarketingToolDefinitions(readSubscribedCapabilities()),
    // 向 Agent 注入营销工具的系统提示引导（按订阅过滤，模型「何时用哪个工具」指令集）
    contributePrompts: () => contributePromptsForSubscribed(readSubscribedCapabilities()),
  }
}

/**
 * 读取营销订阅状态（settings.json 权威；未设置回退默认 influencer）。
 * 读取失败（非 electron 等）回退默认。被 isEnabled / contributeTools / contributePrompts 共用。
 */
function readSubscribedCapabilities(): string[] {
  try {
    // 延迟 require 避免与 settings-service 形成初始化阶段循环依赖
    const { getSettings } = require('../settings-service') as { getSettings: () => { marketingCapabilities?: string[] } }
    const caps = getSettings().marketingCapabilities
    return caps && caps.length > 0 ? caps : [...DEFAULT_ENABLED_CAPABILITIES]
  } catch {
    return [...DEFAULT_ENABLED_CAPABILITIES]
  }
}
