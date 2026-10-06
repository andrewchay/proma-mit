/**
 * M6-02 参数化成本模型。
 *
 * 价格与能力都可替换注入；估算必须携带 priceSource 与 assumptions，
 * 让每一次账单估算都可追溯。未知 cache 一律按 miss（全价 input）计费。
 */
import type { ProviderType } from '../types/channel'
import { getProviderCostCapability, type ProviderCostCapability } from './provider-cost-capability'

export interface ModelPricing {
  currency: 'USD' | 'CNY'
  /** 价格来源说明（URL/日期），必填，保证估算可追溯。 */
  source: string
  inputPerMTokens: number
  outputPerMTokens: number
  /** 未提供时按 input 单价计（保守）。 */
  cacheReadPerMTokens?: number
  cacheWritePerMTokens?: number
}

export interface RequestUsage {
  provider: ProviderType
  modelId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** 失败重试次数；按整轮 input+output 重复计费。 */
  retries?: number
}

export interface RequestCostEstimate {
  currency: 'USD' | 'CNY'
  priceSource: string
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  retryCost: number
  total: number
  /** 计价时做出的全部保守假设，逐条可审计。 */
  assumptions: string[]
}

export function estimateRequestCost(
  usage: RequestUsage,
  pricing: ModelPricing,
  capability: ProviderCostCapability = getProviderCostCapability(usage.provider),
): RequestCostEstimate {
  assertNonNegative(usage.inputTokens, 'inputTokens')
  assertNonNegative(usage.outputTokens, 'outputTokens')
  assertNonNegative(usage.cacheReadTokens ?? 0, 'cacheReadTokens')
  assertNonNegative(usage.cacheWriteTokens ?? 0, 'cacheWriteTokens')
  assertNonNegative(usage.retries ?? 0, 'retries')
  if (!isNonEmptyString(pricing.source)) throw new Error('pricing.source is required for traceable estimates')

  const assumptions: string[] = []
  const perMillion = (tokens: number, unitPrice: number): number => (tokens / 1_000_000) * unitPrice

  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  let cacheReadCost = 0
  let cacheWriteCost = 0
  let effectiveInputTokens = usage.inputTokens

  if (capability.promptCache !== 'supported') {
    // 未知/不支持的 cache：cache-read tokens 按全价 input 计，绝不假装命中缓存。
    if (cacheRead > 0) assumptions.push(`provider ${usage.provider} cache capability is ${capability.promptCache}: cache-read tokens priced as full input`)
    if (cacheWrite > 0) assumptions.push(`provider ${usage.provider} cache capability is ${capability.promptCache}: cache-write tokens priced as full input`)
    effectiveInputTokens += cacheRead + cacheWrite
  } else {
    if (pricing.cacheReadPerMTokens === undefined && cacheRead > 0) {
      assumptions.push('cacheReadPerMTokens not provided: cache-read tokens priced at input rate')
    }
    if (pricing.cacheWritePerMTokens === undefined && cacheWrite > 0) {
      assumptions.push('cacheWritePerMTokens not provided: cache-write tokens priced at input rate')
    }
    cacheReadCost = perMillion(cacheRead, pricing.cacheReadPerMTokens ?? pricing.inputPerMTokens)
    cacheWriteCost = perMillion(cacheWrite, pricing.cacheWritePerMTokens ?? pricing.inputPerMTokens)
  }

  const inputCost = perMillion(effectiveInputTokens, pricing.inputPerMTokens)
  const outputCost = perMillion(usage.outputTokens, pricing.outputPerMTokens)
  const retries = usage.retries ?? 0
  const retryCost = retries > 0
    ? retries * (perMillion(usage.inputTokens + cacheRead + cacheWrite, pricing.inputPerMTokens) + outputCost)
    : 0
  if (retries > 0) assumptions.push(`retries (${retries}) priced as full extra turns`)

  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost + retryCost
  return {
    currency: pricing.currency,
    priceSource: pricing.source,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    retryCost,
    total,
    assumptions,
  }
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number`)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
