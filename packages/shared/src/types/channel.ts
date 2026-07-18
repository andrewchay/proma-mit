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
  google: 'Google',
  'kimi-api': 'Kimi API (Anthropic 协议)',
  'kimi-coding': 'Kimi Coding Plan',
  zhipu: '智谱 AI',
  minimax: 'MiniMax (API&编程包)',
  doubao: '豆包',
  qwen: '通义千问',
  custom: 'OpenAI 兼容格式',
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
    runtimes: ['claude', 'pi'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: true,
  },
  openai: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi'],
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
    },
    runtimes: ['claude', 'proma', 'pi'],
    supportsToolCalling: true,
    supportsImages: false,
    supportsStreamUsage: true,
    verifiedForAgentRuntime: false,
  },
  google: {
    protocol: 'google-generative',
    runtimes: ['pi'],
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
    },
    runtimes: ['claude', 'proma', 'pi'],
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
    },
    runtimes: ['claude', 'proma', 'pi'],
    supportsToolCalling: true,
    supportsImages: false,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: true,
  },
  zhipu: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
  minimax: {
    protocol: 'anthropic-messages',
    runtimes: ['claude', 'pi'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: true,
  },
  doubao: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
  qwen: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi'],
    supportsToolCalling: true,
    supportsImages: true,
    supportsStreamUsage: false,
    verifiedForAgentRuntime: false,
  },
  custom: {
    protocol: 'openai-chat',
    runtimes: ['proma', 'pi'],
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
 */
export function isAgentCompatibleProvider(provider: ProviderType, runtime: AgentRuntime = 'claude'): boolean {
  return AGENT_PROVIDER_RUNTIME_CAPABILITIES[provider].runtimes.includes(runtime)
}

/** 获取指定 runtime 当前可用的 provider 列表 */
export function getAgentCompatibleProviders(runtime: AgentRuntime): ProviderType[] {
  return Object.entries(AGENT_PROVIDER_RUNTIME_CAPABILITIES)
    .filter(([, capability]) => capability.runtimes.includes(runtime))
    .map(([provider]) => provider as ProviderType)
}

/** 获取 provider 在 Agent runtime 下的协议族 */
export function getAgentProviderProtocol(provider: ProviderType, runtime?: AgentRuntime): AgentProviderProtocol {
  const capability = AGENT_PROVIDER_RUNTIME_CAPABILITIES[provider]
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
  if (provider === 'deepseek' && runtime === 'proma') {
    return normalized
      .replace(/\/anthropic\/v\d+\/messages$/, '')
      .replace(/\/anthropic\/v\d+$/, '')
      .replace(/\/anthropic$/, '')
  }
  if ((provider === 'kimi-api' || provider === 'kimi-coding') && runtime === 'proma') {
    return normalized
      .replace(/\/messages$/, '')
      .replace(/\/anthropic\/v\d+$/, '')
      .replace(/\/anthropic$/, '')
      .replace(/\/coding\/v\d+$/, '')
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
} as const
