/**
 * M6-03 隐私与 model policy。
 *
 * fail-closed：allowlist 为空 = 全部拒绝；敏感数据只能去能力已验证的 provider。
 */
import type { ProviderType } from '../types/channel'
import { getProviderCostCapability } from './provider-cost-capability'

export interface RoutingPolicy {
  /** 显式允许的 provider；空数组 = 拒绝一切（fail-closed）。 */
  providerAllowlist: readonly ProviderType[]
  /** 可选的模型白名单；未定义 = 不按模型限制。 */
  allowedModels?: readonly string[]
  /** 敏感数据是否只允许发往能力已验证的 provider（默认 true）。 */
  sensitiveDataRequiresVerifiedProvider?: boolean
}

export interface RouteCandidate {
  id: string
  provider: ProviderType
  modelId: string
  /** 该请求是否携带敏感内容（私密路径、凭据等）。 */
  hasSensitiveData?: boolean
}

export interface RoutingPolicyDecision {
  allowed: boolean
  reasons: string[]
}

export function evaluateRoutingPolicy(policy: RoutingPolicy, candidate: RouteCandidate): RoutingPolicyDecision {
  const reasons: string[] = []
  if (policy.providerAllowlist.length === 0) {
    reasons.push('provider allowlist is empty: fail-closed deny')
    return { allowed: false, reasons }
  }
  if (!policy.providerAllowlist.includes(candidate.provider)) {
    reasons.push(`provider ${candidate.provider} is not in the allowlist`)
  }
  if (policy.allowedModels && !policy.allowedModels.includes(candidate.modelId)) {
    reasons.push(`model ${candidate.modelId} is not in the allowed model list`)
  }
  const sensitiveRequiresVerified = policy.sensitiveDataRequiresVerifiedProvider ?? true
  if (candidate.hasSensitiveData && sensitiveRequiresVerified) {
    const capability = getProviderCostCapability(candidate.provider)
    if (!capability.verified) {
      reasons.push(`sensitive data cannot be sent to unverified provider ${candidate.provider}`)
    }
  }
  return { allowed: reasons.length === 0, reasons }
}
