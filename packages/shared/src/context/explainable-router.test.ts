import { describe, expect, test } from 'bun:test'
import { routeModelRequest } from './explainable-router'
import type { ModelPricing } from './cost-model'

const pricing: ModelPricing = {
  currency: 'USD',
  source: 'unit-test fixture @ 2026-09-22',
  inputPerMTokens: 3,
  outputPerMTokens: 12,
  cacheReadPerMTokens: 0.6,
}

const usage = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 200_000 }

describe('M6-04 explainable router', () => {
  test('ties break stably and lower-cost compliant candidates win', () => {
    // 两个候选定价与能力等价 → 成本相同，平局按输入顺序取第一个
    const tie = routeModelRequest({
      candidates: [
        { id: 'first', provider: 'anthropic', modelId: 'claude-test' },
        { id: 'second', provider: 'anthropic', modelId: 'claude-test' },
      ],
      policy: { providerAllowlist: ['anthropic'] },
      pricing,
      usage,
    })
    expect(tie.chosenId).toBe('first')

    // unknown-cache 候选被按 miss 计价后更贵 → 支持缓存的候选胜出
    const decision = routeModelRequest({
      candidates: [
        { id: 'cache-unknown', provider: 'custom', modelId: 'm' },
        { id: 'cache-supported', provider: 'anthropic', modelId: 'claude-test' },
      ],
      policy: { providerAllowlist: ['anthropic', 'custom'] },
      pricing,
      usage,
    })
    expect(decision.chosenId).toBe('cache-supported')
    expect(decision.reasons[0]).toContain('selected cache-supported')
  })

  test('surfaces the unknown-cache assumption in the decision reasons', () => {
    const decision = routeModelRequest({
      candidates: [{ id: 'mystery', provider: 'custom', modelId: 'm' }],
      policy: { providerAllowlist: ['custom'] },
      pricing,
      usage,
    })

    expect(decision.chosenId).toBe('mystery')
    expect(decision.reasons.some((reason) => reason.includes('cache capability is unknown: cache-read tokens priced as full input'))).toBe(true)
  })

  test('rejects non-compliant candidates with reasons and never picks them', () => {
    const decision = routeModelRequest({
      candidates: [
        { id: 'blocked-provider', provider: 'minimax', modelId: 'm' },
        { id: 'blocked-model', provider: 'anthropic', modelId: 'other' },
        { id: 'ok', provider: 'anthropic', modelId: 'claude-test' },
      ],
      policy: { providerAllowlist: ['anthropic'], allowedModels: ['claude-test'] },
      pricing,
      usage,
    })

    expect(decision.chosenId).toBe('ok')
    expect(decision.rejections.map((rejection) => rejection.id)).toEqual(['blocked-provider', 'blocked-model'])
    expect(decision.rejections[0]!.reason).toContain('not in the allowlist')
  })

  test('returns null with every rejection explained when nothing passes', () => {
    const decision = routeModelRequest({
      candidates: [{ id: 'blocked', provider: 'minimax', modelId: 'm' }],
      policy: { providerAllowlist: ['anthropic'] },
      pricing,
      usage,
    })

    expect(decision.chosenId).toBeNull()
    expect(decision.reasons).toEqual(['no candidate passed the routing policy'])
    expect(decision.rejections[0]!.reason).toContain('not in the allowlist')
    expect(decision.cost).toBeUndefined()
  })
})
