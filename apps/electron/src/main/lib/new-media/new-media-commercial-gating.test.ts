import { afterAll, describe, expect, test } from 'bun:test'
import type { NewMediaCommercialProof } from '@gravitas/shared'
import {
  COMMERCIAL_CAPABILITY_PROOF_TYPES,
  assertCommercialCapabilityEnabled,
  evaluateCommercialCapabilities,
  evaluateCommercialCapability,
  isCommercialCapability,
  isKnownProofType,
} from './new-media-commercial-gating'

const NOW = Date.parse('2026-09-17T00:00:00Z')
const DAY = 86_400_000

function proof(overrides: Partial<NewMediaCommercialProof> = {}): NewMediaCommercialProof {
  return {
    id: 'proof-1',
    type: 'scope_grant',
    capability: 'pugongying-data',
    reference: '平台工单 #12345',
    grantedAt: NOW - 10 * DAY,
    verifiedBy: 'Carol',
    ...overrides,
  }
}

describe('P4-01 商业能力门控', () => {
  test('已知商业能力与证明类型登记在案', () => {
    expect(Object.keys(COMMERCIAL_CAPABILITY_PROOF_TYPES).sort()).toEqual([
      'juguang-ads', 'licensed-listening', 'pugongying-data', 'xiaohongshu-dm',
    ])
    // 聚光只接受白名单（平台口径），供应商数据只接受许可协议
    expect(COMMERCIAL_CAPABILITY_PROOF_TYPES['juguang-ads']).toEqual(['whitelist'])
    expect(COMMERCIAL_CAPABILITY_PROOF_TYPES['licensed-listening']).toEqual(['vendor_license'])
    expect(isCommercialCapability('pugongying-data')).toBe(true)
    expect(isCommercialCapability('content-operations')).toBe(false)
    expect(isKnownProofType('whitelist')).toBe(true)
    expect(isKnownProofType('口头承诺')).toBe(false)
  })

  test('无证明时保持关闭，且说明不得对外承诺', () => {
    const state = evaluateCommercialCapability({ capability: 'pugongying-data', proofs: [] }, NOW)
    expect(state.enabled).toBe(false)
    expect(state.reason).toBe('no_proof')
    expect(state.explanation).toContain('不得实现调用或对外承诺')
  })

  test('未核验的证明不足以启用', () => {
    const state = evaluateCommercialCapability({ capability: 'pugongying-data', proofs: [proof({ verifiedBy: '  ' })] }, NOW)
    expect(state.enabled).toBe(false)
    expect(state.reason).toBe('proof_not_verified')
    expect(state.proofId).toBe('proof-1')
  })

  test('过期证明关闭能力且不留宽限，过期时间可见', () => {
    const state = evaluateCommercialCapability({
      capability: 'juguang-ads',
      proofs: [proof({ type: 'whitelist', capability: 'juguang-ads', expiresAt: NOW - DAY })],
    }, NOW)
    expect(state.enabled).toBe(false)
    expect(state.reason).toBe('proof_expired')
    expect(state.expiresAt).toBe(NOW - DAY)
  })

  test('类型不匹配的证明无效（聚光不接受 scope_grant）', () => {
    const state = evaluateCommercialCapability({
      capability: 'juguang-ads',
      proofs: [proof({ type: 'scope_grant', capability: 'juguang-ads' })],
    }, NOW)
    expect(state.enabled).toBe(false)
    expect(state.reason).toBe('no_proof')
  })

  test('有效证明启用能力，多份并存取最晚过期的一份', () => {
    const state = evaluateCommercialCapability({
      capability: 'pugongying-data',
      proofs: [
        proof({ id: 'p1', expiresAt: NOW + 30 * DAY }),
        proof({ id: 'p2', expiresAt: NOW + 90 * DAY, reference: '续期合同 #999' }),
      ],
    }, NOW)
    expect(state.enabled).toBe(true)
    expect(state.proofId).toBe('p2')
    expect(state.expiresAt).toBe(NOW + 90 * DAY)
  })

  test('无到期日的证明视为长期有效，但仍需核验', () => {
    expect(evaluateCommercialCapability({ capability: 'pugongying-data', proofs: [proof()] }, NOW).enabled).toBe(true)
    expect(evaluateCommercialCapability({ capability: 'licensed-listening', proofs: [proof({ type: 'vendor_license', capability: 'licensed-listening' })] }, NOW).enabled).toBe(true)
  })

  test('批量评估给出启用清单；构造入口在门控未通过时直接抛错', () => {
    const batch = evaluateCommercialCapabilities({
      capabilities: ['pugongying-data', 'juguang-ads', 'licensed-listening'],
      proofs: [proof(), proof({ type: 'vendor_license', capability: 'licensed-listening' })],
    }, NOW)
    expect(batch.enabledCapabilities).toEqual(['pugongying-data', 'licensed-listening'])
    expect(batch.states.find((state) => state.capability === 'juguang-ads')?.reason).toBe('no_proof')

    expect(() => assertCommercialCapabilityEnabled({ capability: 'juguang-ads', proofs: [] }, NOW)).toThrow(/商业能力未启用（no_proof）/)
    expect(assertCommercialCapabilityEnabled({ capability: 'pugongying-data', proofs: [proof()] }, NOW).enabled).toBe(true)
  })
})
