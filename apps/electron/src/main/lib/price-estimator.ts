/**
 * 本地价格估算器 — Price Estimator（PH2-①）
 *
 * 部分 Provider / Model 的 SDK usage 不返回 cost 字段（costTotal 恒 0）。
 * 当 provider 未给 cost 但有 token 计数时，用本地的默认价格目录估算费用，
 * 使「费用审计 / Token 统计」不再显示 0。
 *
 * 价格单位：USD / 百万 token（与 server billing 的 UsagePriceEntry 一致）。
 */

export interface ModelPrice {
  inputPerMillionUsd: number
  outputPerMillionUsd: number
  cacheReadPerMillionUsd?: number
}

/** 常见模型默认价格（USD/百万）。仅供参考，精确价格以模型 Provider 账单向准。 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet': { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  'claude-opus': { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
  'claude-haiku': { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 },
  'gpt-4o': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
  'gpt-4': { inputPerMillionUsd: 30, outputPerMillionUsd: 60 },
  'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  'deepseek': { inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.1 },
  'o3': { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
  'gemini': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5 },
}

/** 未知模型的兜底价格 */
const FALLBACK_PRICE: ModelPrice = { inputPerMillionUsd: 2, outputPerMillionUsd: 8 }

/** 从 modelId 匹配一个默认价格（前缀匹配，忽略版本/日期后缀）。 */
export function resolvePrice(modelId: string | undefined): ModelPrice {
  const id = modelId ?? ''
  const lower = id.toLowerCase()
  for (const key of Object.keys(DEFAULT_PRICES)) {
    if (lower.includes(key.toLowerCase())) return DEFAULT_PRICES[key]!
  }
  return FALLBACK_PRICE
}

/** 估算一次调用的 cost（USD）。tokens 缺失视为 0。 */
export function estimateCost(
  modelId: string | undefined,
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number },
): number {
  const price = resolvePrice(modelId)
  const perMil = 1_000_000
  const input = (usage.inputTokens ?? 0) * (price.inputPerMillionUsd / perMil)
  const output = (usage.outputTokens ?? 0) * (price.outputPerMillionUsd / perMil)
  const cache = (usage.cacheReadTokens ?? 0) * ((price.cacheReadPerMillionUsd ?? price.inputPerMillionUsd) / perMil)
  return input + output + cache
}
