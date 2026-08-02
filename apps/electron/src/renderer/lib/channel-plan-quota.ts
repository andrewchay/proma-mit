/**
 * 渠道订阅 Plan 额度查询（renderer 侧）—— 移植自本地 Proma。
 *
 * 带缓存（60s 成功 / 15s 失败）+ in-flight 去重 + 渠道凭据变更失效。
 */

import type { Channel, ChannelPlanQuotaResult, ProviderType } from '@proma/shared'

const PLAN_QUOTA_PROVIDERS = new Set<ProviderType>([
  'deepseek',
  'deepseek-openai',
  'kimi-coding',
])

/** 判断 Base URL 是否指向 DeepSeek 官方域名 */
function isDeepSeekBaseUrl(baseUrl: string): boolean {
  return /api\.deepseek\.com/i.test(baseUrl)
}

/** 判断 Base URL 是否指向 Kimi Coding Plan */
function isKimiCodingBaseUrl(baseUrl: string): boolean {
  return /api\.kimi\.com\/coding/i.test(baseUrl)
}

export function supportsChannelPlanQuota(channel: Pick<Channel, 'provider' | 'baseUrl'> | null | undefined): boolean {
  if (!channel) return false
  if (PLAN_QUOTA_PROVIDERS.has(channel.provider)) return true
  // 自定义 OpenAI 兼容渠道若实际是 DeepSeek/Kimi，也支持余额查询
  if (channel.provider === 'custom') {
    return isDeepSeekBaseUrl(channel.baseUrl) || isKimiCodingBaseUrl(channel.baseUrl)
  }
  return isKimiCodingBaseUrl(channel.baseUrl)
}

const PLAN_QUOTA_CACHE_MS = 60 * 1000
const PLAN_QUOTA_ERROR_CACHE_MS = 15 * 1000

interface CachedPlanQuota {
  result: ChannelPlanQuotaResult
  /** 渠道凭据更新时递增，避免同一 channelId 换号后沿用旧账号额度。 */
  channelUpdatedAt?: number
}

const quotaCache = new Map<string, CachedPlanQuota>()
const inflightRequests = new Map<string, Promise<ChannelPlanQuotaResult>>()

function getCacheTtl(result: ChannelPlanQuotaResult): number {
  return result.supported ? PLAN_QUOTA_CACHE_MS : PLAN_QUOTA_ERROR_CACHE_MS
}

export function getCachedPlanQuota(channelId: string, channelUpdatedAt?: number): ChannelPlanQuotaResult | null {
  const cached = quotaCache.get(channelId)
  if (!cached || cached.channelUpdatedAt !== channelUpdatedAt) return null
  if (Date.now() - cached.result.updatedAt >= getCacheTtl(cached.result)) return null
  return cached.result
}

export async function fetchChannelPlanQuota(
  channelId: string,
  channelUpdatedAt?: number,
): Promise<ChannelPlanQuotaResult> {
  const cached = getCachedPlanQuota(channelId, channelUpdatedAt)
  if (cached) return cached

  // 同一渠道换号后不能复用旧凭据发起的 in-flight 请求。
  const requestKey = `${channelId}:${channelUpdatedAt ?? ''}`
  const inflight = inflightRequests.get(requestKey)
  if (inflight) return inflight

  const request = window.electronAPI.getChannelPlanQuota(channelId)
    .then((result) => {
      quotaCache.set(channelId, { result, channelUpdatedAt })
      return result
    })
    .catch((error: unknown) => {
      const result: ChannelPlanQuotaResult = {
        supported: false,
        provider: 'custom',
        windows: [],
        updatedAt: Date.now(),
        message: error instanceof Error ? error.message : '订阅额度查询失败',
      }
      quotaCache.set(channelId, { result, channelUpdatedAt })
      return result
    })
    .finally(() => {
      inflightRequests.delete(requestKey)
    })

  inflightRequests.set(requestKey, request)
  return request
}
