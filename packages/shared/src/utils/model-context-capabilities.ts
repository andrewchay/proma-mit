import type { ProviderType } from '../types/channel'

/** 模型上下文窗口的可信来源。 */
export type ContextWindowSource = 'catalog' | 'override' | 'fallback'

/** 单个模型的上下文窗口能力。 */
export interface ModelContextCapability {
  contextWindow: number
  source: ContextWindowSource
}

/** 查询模型上下文能力时需要的稳定身份。 */
export interface ResolveModelContextCapabilityInput {
  provider: ProviderType
  modelId: string | undefined | null
  contextWindowOverride?: number
}

/** 未收录模型的保守上下文窗口兜底。 */
export const DEFAULT_UNKNOWN_CONTEXT_WINDOW = 256_000

const KIMI_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'kimi-k3': 1_000_000,
  // 部分 Kimi 兼容渠道把 API 模型 ID 简化为显示名。仅在 Kimi provider 下接受该精确别名，
  // 避免将其他厂商的同名模型误判为 K3。
  k3: 1_000_000,
  'kimi-k3-256k': 256_000,
  'kimi-k2.6': 256_000,
  'kimi-k2.5': 256_000,
  'kimi-k2.7-code': 256_000,
  'kimi-k2.7-code-highspeed': 256_000,
}

/**
 * 返回模型上下文窗口。
 *
 * 显式配置优先于内置目录；未知模型保守回退到 256K，调用方可据此展示不确定性。
 */
export function resolveModelContextCapability(
  input: ResolveModelContextCapabilityInput,
): ModelContextCapability {
  if (isPositiveInteger(input.contextWindowOverride)) {
    return { contextWindow: input.contextWindowOverride, source: 'override' }
  }

  const modelId = input.modelId?.trim().toLowerCase()
  if (modelId && (input.provider === 'kimi-api' || input.provider === 'kimi-coding')) {
    const contextWindow = KIMI_CONTEXT_WINDOWS[modelId]
    if (contextWindow) return { contextWindow, source: 'catalog' }
  }

  return { contextWindow: DEFAULT_UNKNOWN_CONTEXT_WINDOW, source: 'fallback' }
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0
}
