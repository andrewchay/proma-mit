/**
 * M6-01 Provider 成本能力登记表。
 *
 * 只登记**已验证**的 cache/工具/schema 能力；未登记的 provider 一律返回
 * 保守默认（unknown），调用方必须按「unknown cache = miss」计价，绝不假设支持。
 */
import type { ProviderType } from '../types/channel'

export interface ProviderCostCapability {
  /** prompt cache 能力；unknown 时成本模型必须把 cache-read tokens 按全价 input 计入。 */
  promptCache: 'supported' | 'unsupported' | 'unknown'
  tools: 'supported' | 'unknown'
  schemaMode: 'json-schema' | 'unknown'
  /** 能力来源是否经过真实运行验证。 */
  verified: boolean
  /** 能力结论的依据说明（观测日期/渠道），可审计。 */
  evidence?: string
}

const VERIFIED: Partial<Record<ProviderType, ProviderCostCapability>> = {
  anthropic: {
    promptCache: 'supported',
    tools: 'supported',
    schemaMode: 'json-schema',
    verified: true,
    evidence: 'anthropic prompt caching 为公开产品能力',
  },
  openai: {
    promptCache: 'supported',
    tools: 'supported',
    schemaMode: 'json-schema',
    verified: true,
    evidence: 'openai automatic prompt caching 为公开产品能力',
  },
  deepseek: {
    promptCache: 'supported',
    tools: 'supported',
    schemaMode: 'json-schema',
    verified: true,
    evidence: 'deepseek context caching 为公开产品能力',
  },
  zhipu: {
    promptCache: 'supported',
    tools: 'supported',
    schemaMode: 'json-schema',
    verified: true,
    evidence: '2026-09-22 TCC 代表性评测实测 glm-5.3-flash 返回 cache_hit',
  },
}

const CONSERVATIVE_DEFAULT: ProviderCostCapability = {
  promptCache: 'unknown',
  tools: 'unknown',
  schemaMode: 'unknown',
  verified: false,
}

export function getProviderCostCapability(provider: ProviderType): ProviderCostCapability {
  return VERIFIED[provider] ?? { ...CONSERVATIVE_DEFAULT }
}
