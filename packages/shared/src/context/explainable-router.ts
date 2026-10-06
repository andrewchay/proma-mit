/**
 * M6-04 可解释 router。
 *
 * 每一次选择与拒绝都必须带 reason；cache 未知按 miss 计价并写进 reason；
 * 决策纯离线，不改变任何线上模型选择。
 */
import type { ProviderType } from '../types/channel'
import { estimateRequestCost, type ModelPricing, type RequestCostEstimate } from './cost-model'
import { evaluateRoutingPolicy, type RoutingPolicy } from './routing-policy'

export interface RoutingCandidate {
  id: string
  provider: ProviderType
  modelId: string
  hasSensitiveData?: boolean
}

export interface RoutingUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  retries?: number
}

export interface RoutingRejection {
  id: string
  reason: string
}

export interface RoutingDecision {
  chosenId: string | null
  reasons: string[]
  rejections: RoutingRejection[]
  cost?: RequestCostEstimate
}

export function routeModelRequest(input: {
  candidates: readonly RoutingCandidate[]
  policy: RoutingPolicy
  pricing: ModelPricing
  usage: RoutingUsage
}): RoutingDecision {
  const rejections: RoutingRejection[] = []
  const affordable: Array<{ candidate: RoutingCandidate; cost: RequestCostEstimate }> = []

  for (const candidate of input.candidates) {
    const policyDecision = evaluateRoutingPolicy(input.policy, candidate)
    if (!policyDecision.allowed) {
      rejections.push({ id: candidate.id, reason: policyDecision.reasons.join('; ') })
      continue
    }
    const cost = estimateRequestCost(
      {
        provider: candidate.provider,
        modelId: candidate.modelId,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        retries: input.usage.retries,
      },
      input.pricing,
    )
    affordable.push({ candidate, cost })
  }

  if (affordable.length === 0) {
    return {
      chosenId: null,
      reasons: ['no candidate passed the routing policy'],
      rejections,
    }
  }

  let best = affordable[0]!
  const reasons: string[] = []
  for (const entry of affordable.slice(1)) {
    if (entry.cost.total < best.cost.total) best = entry
  }
  reasons.push(`selected ${best.candidate.id} (${best.candidate.provider}/${best.candidate.modelId}) with the lowest estimated total ${best.cost.total.toFixed(6)} ${best.cost.currency}`)
  reasons.push(`price source: ${best.cost.priceSource}`)
  for (const assumption of best.cost.assumptions) reasons.push(`assumption: ${assumption}`)

  return { chosenId: best.candidate.id, reasons, rejections, cost: best.cost }
}
