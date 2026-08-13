/**
 * 视频引擎凭据解析器 — 渠道（模型配置页）优先，环境变量兜底
 *
 * 视频生成（Seedance / MiniMax H3）不再直接依赖 process.env，
 * 而是优先从「模型配置页」渠道中解析：
 *   - seedance    → doubao 渠道（火山方舟），apiKey + baseUrl（归一化 /api/v3）
 *   - minimax-h3  → minimax 渠道，apiKey + 视频专用 baseUrl（/anthropic → /v1）
 *
 * 未找到可用渠道时回退到旧的 process.env.VOLCENGINE_API_KEY / MINIMAX_API_KEY。
 */
import { listChannels, decryptApiKey } from '../../channel-manager'
import type { Channel } from '@gravitas/shared'
import type { VideoEngineConfig } from './video-generation-service'

// ============================================================
// 常量
// ============================================================

/** 火山方舟默认 Base URL（与 doubao 渠道预设一致） */
const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** MiniMax 视频 API 默认 Base URL */
const MINIMAX_VIDEO_DEFAULT_BASE_URL = 'https://api.minimaxi.com/v1'

/** Seedance 默认模型（doubao 渠道未显式配置 seedance 模型时使用） */
export const SEEDANCE_DEFAULT_MODEL = 'doubao-seedance-2-5-260628'

// ============================================================
// 类型
// ============================================================

export interface ResolvedVideoEngineConfig extends VideoEngineConfig {
  /** 凭据来源：channel = 渠道配置，env = 环境变量 */
  source: 'channel' | 'env'
  /** 命中的渠道 ID（source === 'channel' 时存在） */
  channelId?: string
  /** 命中的渠道名称 */
  channelName?: string
  /** Seedance 模型 ID（仅 seedance） */
  model?: string
}

// ============================================================
// 工具函数
// ============================================================

/** 归一化火山方舟 Base URL：保证以 /api/v3 结尾 */
function normalizeArkBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/\/api\/v\d+$/.test(trimmed)) return trimmed
  try {
    const pathname = new URL(trimmed).pathname
    if (pathname !== '/' && pathname !== '') return trimmed
  } catch {
    // 非法 URL 原样返回，交由引擎调用报错
  }
  return `${trimmed}/api/v3`
}

/** 由 MiniMax 渠道 Base URL（Anthropic 协议）推导视频 API Base URL */
function deriveMiniMaxVideoBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  // https://api.minimaxi.com/anthropic → https://api.minimaxi.com/v1
  if (/\/anthropic$/.test(trimmed)) {
    return trimmed.replace(/\/anthropic$/, '/v1')
  }
  // https://api.minimaxi.com → https://api.minimaxi.com/v1
  try {
    const pathname = new URL(trimmed).pathname
    if (pathname === '/' || pathname === '') return `${trimmed}/v1`
  } catch {
    // 忽略
  }
  return trimmed
}

/** 安全解密渠道 key（解密失败按无凭据处理） */
function safeDecryptApiKey(channelId: string): string {
  try {
    return decryptApiKey(channelId)
  } catch (error) {
    console.warn('[视频凭据] 渠道 API Key 解密失败:', (error as Error).message)
    return ''
  }
}

/** 在渠道中查找第一个 enabled 且 key 非空的指定 provider 渠道；可指定 channelId 精确命中 */
function findUsableChannel(
  provider: Channel['provider'],
  pickModel?: (models: Channel['models']) => string | undefined,
  channelId?: string,
): { id: string; name: string; baseUrl: string; apiKey: string; model?: string } | undefined {
  const channels = listChannels()
  for (const ch of channels) {
    if (channelId && ch.id !== channelId) continue
    if (!ch.enabled) continue
    if (ch.provider !== provider) continue
    const key = safeDecryptApiKey(ch.id)
    if (!key) continue
    return {
      id: ch.id,
      name: ch.name,
      baseUrl: ch.baseUrl,
      apiKey: key,
      model: pickModel?.(ch.models),
    }
  }
  return undefined
}

// ============================================================
// 解析器
// ============================================================

/** 从 doubao 渠道模型中挑选 seedance 系列模型 ID（用于视频生成） */
function pickSeedanceModel(models: Channel['models']): string | undefined {
  const seedance = models.find((m) => /seedance/i.test(m.id))
  return seedance?.id
}

/** 解析 Seedance（火山方舟）引擎配置：doubao 渠道优先，环境变量兜底 */
export function resolveSeedanceConfig(channelId?: string): ResolvedVideoEngineConfig {
  const ch = findUsableChannel('doubao', pickSeedanceModel, channelId)
  if (ch) {
    return {
      apiKey: ch.apiKey,
      baseUrl: normalizeArkBaseUrl(ch.baseUrl),
      source: 'channel',
      channelId: ch.id,
      channelName: ch.name,
      model: ch.model ?? SEEDANCE_DEFAULT_MODEL,
    }
  }

  return {
    apiKey: process.env.VOLCENGINE_API_KEY ?? '',
    baseUrl: ARK_DEFAULT_BASE_URL,
    source: 'env',
    model: SEEDANCE_DEFAULT_MODEL,
  }
}

/** 解析 MiniMax H3 引擎配置：minimax 渠道优先，环境变量兜底 */
export function resolveMiniMaxConfig(channelId?: string): ResolvedVideoEngineConfig {
  const ch = findUsableChannel('minimax', undefined, channelId)
  if (ch) {
    return {
      apiKey: ch.apiKey,
      baseUrl: deriveMiniMaxVideoBaseUrl(ch.baseUrl),
      source: 'channel',
      channelId: ch.id,
      channelName: ch.name,
    }
  }

  return {
    apiKey: process.env.MINIMAX_API_KEY ?? '',
    baseUrl: MINIMAX_VIDEO_DEFAULT_BASE_URL,
    source: 'env',
  }
}

/** 按引擎解析配置；可显式指定渠道 ID（缺省自动选首个可用渠道） */
export function resolveVideoEngineConfig(
  engine: 'seedance' | 'minimax-h3',
  channelId?: string,
): ResolvedVideoEngineConfig {
  return engine === 'minimax-h3' ? resolveMiniMaxConfig(channelId) : resolveSeedanceConfig(channelId)
}
