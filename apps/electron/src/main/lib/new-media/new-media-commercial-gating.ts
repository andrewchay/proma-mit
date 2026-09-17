/**
 * 商业能力授权门控。
 *
 * 与普通能力（P2-01 的能力协商）的本质区别：
 * - 普通能力由平台接口权限决定，调用失败会明确报错；
 * - 商业能力（蒲公英、聚光、私信、供应商数据）是商务授权问题，
 *   没有 scope 书面授权、白名单或许可协议就根本不该开始实现调用。
 *
 * 因此门控规则是保守的：
 * 1. 没有证明 → disabled（no_proof）；
 * 2. 证明存在但未经核验（verifiedBy 为空）→ disabled（proof_not_verified）；
 * 3. 证明已过期 → disabled（proof_expired）；
 * 4. 只有类型匹配、已核验、未过期的证明才启用。
 * 白名单证明过期后必须重新申请，本地不做宽限。
 */
import type {
  NewMediaCommercialGateState,
  NewMediaCommercialProof,
  NewMediaCommercialProofType,
} from '@gravitas/shared'

const PROOF_KINDS: readonly NewMediaCommercialProofType[] = ['scope_grant', 'whitelist', 'vendor_license']

/** 各商业能力接受哪些证明类型；类型不匹配的证明一律无效。 */
export const COMMERCIAL_CAPABILITY_PROOF_TYPES: Record<string, readonly NewMediaCommercialProofType[]> = {
  'pugongying-data': ['scope_grant', 'whitelist'],
  'juguang-ads': ['whitelist'],
  'xiaohongshu-dm': ['scope_grant'],
  'licensed-listening': ['vendor_license'],
}

export function isCommercialCapability(capability: string): boolean {
  return capability in COMMERCIAL_CAPABILITY_PROOF_TYPES
}

export interface CommercialGateInput {
  capability: string
  proofs: NewMediaCommercialProof[]
  now?: number
}

function explanationFor(reason: NewMediaCommercialGateState['reason'], capability: string): string {
  switch (reason) {
    case 'enabled': return '授权证明有效，能力已启用。'
    case 'no_proof': return `尚无「${capability}」的授权证明；该能力不得实现调用或对外承诺。`
    case 'proof_expired': return '授权证明已过期，需要重新取得书面授权后才能继续使用。'
    case 'proof_not_verified': return '授权证明未经核验，必须由明确的责任人核对后才能启用。'
  }
}

/**
 * 评估单个商业能力的门控状态。
 * 多份证明并存时取「过期时间最晚的有效证明」，便于续期交接。
 */
export function evaluateCommercialCapability(input: CommercialGateInput, now = Date.now()): NewMediaCommercialGateState {
  const accepted = COMMERCIAL_CAPABILITY_PROOF_TYPES[input.capability]
  if (!accepted) {
    return { capability: input.capability, enabled: false, reason: 'no_proof', explanation: `未登记的商业能力「${input.capability}」默认关闭。` }
  }
  const candidates = input.proofs
    .filter((proof) => proof.capability === input.capability && accepted.includes(proof.type))
    .filter((proof) => Boolean(proof.verifiedBy?.trim()))
    .filter((proof) => proof.expiresAt === undefined || proof.expiresAt > now)
    .sort((left, right) => (right.expiresAt ?? Number.MAX_SAFE_INTEGER) - (left.expiresAt ?? Number.MAX_SAFE_INTEGER))

  const anyOfType = input.proofs.find((proof) => proof.capability === input.capability && accepted.includes(proof.type))
  if (!anyOfType) {
    return { capability: input.capability, enabled: false, reason: 'no_proof', explanation: explanationFor('no_proof', input.capability) }
  }
  const unverified = input.proofs.find((proof) => proof.capability === input.capability && accepted.includes(proof.type) && !proof.verifiedBy?.trim())
  if (unverified && candidates.length === 0) {
    return { capability: input.capability, enabled: false, reason: 'proof_not_verified', explanation: explanationFor('proof_not_verified', input.capability), proofId: unverified.id }
  }
  const expired = input.proofs
    .filter((proof) => proof.capability === input.capability && accepted.includes(proof.type) && proof.expiresAt !== undefined && proof.expiresAt <= now)
  if (candidates.length === 0 && expired.length > 0) {
    const latest = expired.sort((left, right) => (right.expiresAt ?? 0) - (left.expiresAt ?? 0))[0] as NewMediaCommercialProof
    return { capability: input.capability, enabled: false, reason: 'proof_expired', explanation: explanationFor('proof_expired', input.capability), proofId: latest.id, expiresAt: latest.expiresAt }
  }
  const active = candidates[0] as NewMediaCommercialProof
  return {
    capability: input.capability,
    enabled: true,
    reason: 'enabled',
    explanation: explanationFor('enabled', input.capability),
    proofId: active.id,
    expiresAt: active.expiresAt,
  }
}

/** 批量评估并汇总启用列表。 */
export function evaluateCommercialCapabilities(input: { capabilities: string[]; proofs: NewMediaCommercialProof[] }, now = Date.now()): {
  states: NewMediaCommercialGateState[]
  enabledCapabilities: string[]
} {
  const states = input.capabilities.map((capability) => evaluateCommercialCapability({ capability, proofs: input.proofs }, now))
  return {
    states,
    enabledCapabilities: states.filter((state) => state.enabled).map((state) => state.capability),
  }
}

/**
 * 在实现任何商业调用之前断言门控通过。
 * 用途：商业 Adapter 的构造入口调用它，未通过直接抛错，防止「先写代码后补授权」。
 */
export function assertCommercialCapabilityEnabled(input: CommercialGateInput, now = Date.now()): NewMediaCommercialGateState {
  const state = evaluateCommercialCapability(input, now)
  if (!state.enabled) throw new Error(`商业能力未启用（${state.reason}）：${state.explanation}`)
  return state
}

export function isKnownProofType(type: string): type is NewMediaCommercialProofType {
  return PROOF_KINDS.includes(type as NewMediaCommercialProofType)
}
