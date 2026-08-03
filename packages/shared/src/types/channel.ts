/**
 * 渠道（Channel）相关类型定义
 *
 * 渠道是用户配置的 AI 供应商连接，包含 API Key、模型列表等信息。
 * API Key 使用 Electron safeStorage 加密后存储在本地配置文件中。
 */

import type { AgentRuntime } from './agent'

/**
 * 支持的 AI 供应商类型
 */
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'deepseek-openai'
  | 'google'
  | 'kimi-api'
  | 'kimi-coding'
  | 'zhipu'
  | 'minimax'
  | 'doubao'
  | 'qwen'
  | 'custom'

/**
 * 各供应商的默认 Base URL
 */
export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/anthropic',
  'deepseek-openai': 'https://api.deepseek.com',
  google: 'https://generativelanguage.googleapis.com',
  'kimi-api': 'https://api.moonshot.cn/anthropic',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  minimax: 'https://api.minimaxi.com/anthropic',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  custom: '',
}

/**
 * 供应商显示名称
 */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  'deepseek-openai': 'DeepSeek (OpenAI 兼容)',
  google: 'Google',
  'kimi-api': 'Kimi API (Anthropic 协议)',
  'kimi-coding': 'Kimi Coding Plan',
  zhipu: '智谱 AI',
  minimax: 'MiniMax (API&编程包)',
  doubao: '豆包',
  qwen: '通义千问',
  custom: 'OpenAI 兼容格式',
}

/**
 * 归一化历史/旧版渠道的 provider 值到当前 ProviderType。
 *
 * 旧版本曾使用过 'anthropic-compatible'（Anthropic 兼容网关）与 'proma'（Proma 官方/OpenAI 兼容）
 * 作为 provider 值；当前版本统一归入 custom。未知值原样返回（上层需容错）。
 */
export function normalizeProviderType(provider: string | undefined | null): ProviderType | string {
  if (provider === 'anthropic-compatible' || provider === 'proma') return 'custom'
  return (provider ?? 'custom') as ProviderType | string
}

/** Agent runtime 调用供应商时使用的协议族 */
export type AgentProviderProtocol = 'anthropic-messages' | 'openai-chat' | 'google-generative'

/** 供应商在 Agent runtime 下的能力声明 */
export interface AgentProviderRuntimeCapability {
  /** 供应商默认 Agent API 协议 */
  protocol: AgentProviderProtocol
  /** 指定 runtime 下的 API 协议，未声明时使用 protocol */
  runtimeProtocols?: Partial<Record<AgentRuntime, AgentProviderProtocol>>
  /** 当前确认可用的 Agent runtime */
  runtimes: readonly AgentRuntime[]
  /** 是否确认支持工具调用 */
  supportsToolCalling: boolean
  /** 是否支持图片输入 */
  supportsImages: boolean
  /** 是否支持流式 usage 统计 */
  supportsStreamUsage: boolean
  /** 是否已完成 Agent runtime 合约验证 */
  verifiedForAgentRuntime: boolean
}

/** 各供应商在 Agent runtime 下的能力矩阵 */
export const AGENT_PROVIDER_RUNTIME_CAPABILITIES: Record<ProviderType, AgentProviderRuntimeCapability> = {
  anthropic: {
    protocol: 'anthropic-messages',
    runtimes: ['claude', 'pi', 'proma', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: true,
  },
  openai: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: true,
    verifiedForAgentRuntime: false,
  },
  deepseek: {
    protocol: 'openai-chat',
    runtimeProtocols: {
      claude: 'anthropic-messages',
      proma: 'openai-chat',
      pi: 'anthropic-messages',
      'ai-sdk': 'openai-chat',
    },
    runtimes: ['claude', 'proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: false,
    supportsStreamUsage: true,
    verifiedForAgentRuntime: false,
  },
  'deepseek-openai': {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: false,
    supportsStreamUsage: true,
    verifiedForAgentRuntime: false,
  },
  google: {
    protocol: 'google-generative',
    runtimes: ['pi', 'proma', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
  'kimi-api': {
    protocol: 'anthropic-messages',
    runtimeProtocols: {
      claude: 'anthropic-messages',
      proma: 'openai-chat',
      pi: 'anthropic-messages',
      'ai-sdk': 'openai-chat',
    },
    runtimes: ['claude', 'proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: true,
  },
  'kimi-coding': {
    protocol: 'anthropic-messages',
    runtimeProtocols: {
      claude: 'anthropic-messages',
      proma: 'openai-chat',
      pi: 'anthropic-messages',
      'ai-sdk': 'openai-chat',
    },
    runtimes: ['claude', 'proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: false,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: true,
  },
  zhipu: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
  minimax: {
    protocol: 'anthropic-messages',
    runtimes: ['claude', 'pi', 'proma'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: true,
  },
  doubao: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
  qwen: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
  custom: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi', 'ai-sdk'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
}

/**
 * 支持 Claude runtime Agent 模式的供应商类型
 *
 * Agent SDK 通过 Anthropic 兼容协议调用 `/v1/messages` 端点，
 * 因此所有 Anthropic 协议兼容的供应商都可以用于 Agent。
 */
export const AGENT_COMPATIBLE_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>(
  Object.entries(AGENT_PROVIDER_RUNTIME_CAPABILITIES)
    .filter(([, capability]) => capability.runtimes.includes('claude'))
    .map(([provider]) => provider as ProviderType),
)

/**
 * 判断供应商是否兼容指定 Agent runtime。未传 runtime 时保持旧行为：按 Claude runtime 判断。
 *
 * 容错：未知 provider（历史数据中可能残留旧值，如 'anthropic-compatible' / 'proma'）
 * 一律按不兼容处理，避免 undefined.runtimes 崩溃。
 */
export function isAgentCompatibleProvider(provider: ProviderType, runtime: AgentRuntime = 'claude'): boolean {
  return AGENT_PROVIDER_RUNTIME_CAPABILITIES[provider]?.runtimes.includes(runtime) ?? false
}

/** 获取指定 runtime 当前可用的 provider 列表 */
export function getAgentCompatibleProviders(runtime: AgentRuntime): ProviderType[] {
  return Object.entries(AGENT_PROVIDER_RUNTIME_CAPABILITIES)
    .filter(([, capability]) => capability.runtimes.includes(runtime))
    .map(([provider]) => provider as ProviderType)
}

/** 获取 provider 在 Agent runtime 下的协议族；未知 provider 回退到 openai-chat，避免崩溃 */
export function getAgentProviderProtocol(provider: ProviderType, runtime?: AgentRuntime): AgentProviderProtocol {
  const capability = AGENT_PROVIDER_RUNTIME_CAPABILITIES[provider]
  if (!capability) return 'openai-chat'
  return runtime ? capability.runtimeProtocols?.[runtime] ?? capability.protocol : capability.protocol
}

/**
 * 根据 Agent runtime 解析实际请求使用的 baseUrl。
 *
 * DeepSeek 在 Claude runtime 下使用 Anthropic-compatible `/anthropic` 端点；
 * 在 Proma runtime 下使用 OpenAI-compatible `/chat/completions`，因此需要把
 * 历史默认值 `https://api.deepseek.com/anthropic` 转成 `https://api.deepseek.com`。
 */
export function resolveAgentRuntimeBaseUrl(provider: ProviderType, runtime: AgentRuntime, baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (provider === 'deepseek' && (runtime === 'proma' || runtime === 'ai-sdk')) {
    return normalized
      .replace(/\/anthropic\/v\d+\/messages$/, '')
      .replace(/\/anthropic\/v\d+$/, '')
      .replace(/\/anthropic$/, '')
  }
  if (provider === 'kimi-api' && (runtime === 'proma' || runtime === 'ai-sdk')) {
    return normalized
      .replace(/\/messages$/, '')
      .replace(/\/anthropic\/v\d+$/, '')
      .replace(/\/anthropic$/, '')
  }
  if (provider === 'kimi-coding' && (runtime === 'proma' || runtime === 'ai-sdk')) {
    return normalized
      .replace(/\/chat\/completions$/, '')
      .replace(/\/messages$/, '')
  }
  return normalized
}

/**
 * 渠道中的模型配置
 */
export interface ChannelModel {
  /** 模型唯一标识（如 claude-sonnet-4-5-20250929） */
  id: string
  /** 模型显示名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
}

/**
 * 渠道配置
 *
 * 存储在 ~/.proma/channels.json 中，apiKey 字段为加密后的 base64 字符串
 */
export interface Channel {
  /** 渠道唯一标识 */
  id: string
  /** 渠道名称（用户自定义） */
  name: string
  /** AI 供应商类型 */
  provider: ProviderType
  /** API Base URL */
  baseUrl: string
  /** 加密后的 API Key（base64 编码） */
  apiKey: string
  /** 可用模型列表 */
  models: ChannelModel[]
  /** 是否启用 */
  enabled: boolean
  /** 创建时间戳 */
  createdAt: number
  /** 更新时间戳 */
  updatedAt: number
}

/**
 * 创建渠道时的输入数据（apiKey 为明文）
 */
export interface ChannelCreateInput {
  name: string
  provider: ProviderType
  baseUrl: string
  /** 明文 API Key，主进程会加密后存储 */
  apiKey: string
  models: ChannelModel[]
  enabled: boolean
}

/**
 * 更新渠道时的输入数据（所有字段可选）
 */
export interface ChannelUpdateInput {
  name?: string
  provider?: ProviderType
  baseUrl?: string
  /** 明文 API Key，为空字符串表示不更新 */
  apiKey?: string
  models?: ChannelModel[]
  enabled?: boolean
}

/**
 * 渠道配置文件格式
 */
export interface ChannelsConfig {
  /** 配置版本号 */
  version: number
  /** 渠道列表 */
  channels: Channel[]
}

/**
 * 连接测试结果
 */
export interface ChannelTestResult {
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
}

/**
 * 拉取模型的输入参数（无需已保存的渠道，直接传入凭证）
 */
export interface FetchModelsInput {
  provider: ProviderType
  baseUrl: string
  /** 明文 API Key */
  apiKey: string
}

/**
 * 拉取模型的结果
 */
export interface FetchModelsResult {
  /** 是否成功 */
  success: boolean
  /** 结果消息 */
  message: string
  /** 获取到的模型列表 */
  models: ChannelModel[]
}

/**
 * 订阅 Plan 的窗口型额度。
 *
 * 用于展示类似「每 5 小时」和「每周」这类限频窗口的剩余比例。
 */
export interface ChannelPlanQuotaWindow {
  /** 窗口类型标识 */
  type: '5h' | 'weekly' | 'custom'
  /** 展示标签 */
  label: string
  /** 剩余额度百分比，0-100 */
  remainingPercent: number
  /** 已使用百分比，0-100 */
  usedPercent: number
  /** 覆盖展示值。用于余额等无法自然转成百分比的额度。 */
  remainingLabel?: string
  /** 是否展示进度条。默认展示。 */
  showProgress?: boolean
  /** 重置时间戳（毫秒） */
  resetAt?: number
}

/**
 * 渠道订阅 Plan 额度查询结果。
 */
export interface ChannelPlanQuotaResult {
  /** 当前渠道是否支持订阅额度查询 */
  supported: boolean
  /** 渠道供应商类型 */
  provider: ProviderType
  /** Plan 展示名称 */
  planName?: string
  /** 查询到的窗口额度列表 */
  windows: ChannelPlanQuotaWindow[]
  /** 查询时间戳（毫秒） */
  updatedAt: number
  /** 不支持或查询失败时的用户可读原因 */
  message?: string
}

/**
 * 渠道相关 IPC 通道常量
 */
export const CHANNEL_IPC_CHANNELS = {
  /** 获取所有渠道列表 */
  LIST: 'channel:list',
  /** 创建渠道 */
  CREATE: 'channel:create',
  /** 更新渠道 */
  UPDATE: 'channel:update',
  /** 删除渠道 */
  DELETE: 'channel:delete',
  /** 解密获取明文 API Key */
  DECRYPT_KEY: 'channel:decrypt-key',
  /** 测试渠道连接 */
  TEST: 'channel:test',
  /** 从供应商拉取可用模型列表 */
  FETCH_MODELS: 'channel:fetch-models',
  /** 直接测试连接（无需已保存渠道，传入明文凭证） */
  TEST_DIRECT: 'channel:test-direct',
  /** 查询渠道订阅 Plan 额度 */
  GET_PLAN_QUOTA: 'channel:get-plan-quota',
} as const
