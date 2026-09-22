import { describe, expect, test } from 'bun:test'
import { evaluateRoutingPolicy, type RoutingPolicy } from './routing-policy'

const policy: RoutingPolicy = {
  providerAllowlist: ['anthropic', 'zhipu'],
  allowedModels: ['claude-test', 'glm-5.3-flash'],
}

describe('M6-03 routing policy', () => {
  test('empty allowlist denies everything (fail-closed)', () => {
    const decision = evaluateRoutingPolicy({ providerAllowlist: [] }, { id: 'a', provider: 'anthropic', modelId: 'claude-test' })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toEqual(['provider allowlist is empty: fail-closed deny'])
  })

  test('denies providers and models outside the allowlist with explicit reasons', () => {
    const provider = evaluateRoutingPolicy(policy, { id: 'a', provider: 'minimax', modelId: 'claude-test' })
    expect(provider.allowed).toBe(false)
    expect(provider.reasons).toEqual(['provider minimax is not in the allowlist'])

    const model = evaluateRoutingPolicy(policy, { id: 'a', provider: 'anthropic', modelId: 'other-model' })
    expect(model.allowed).toBe(false)
    expect(model.reasons).toEqual(['model other-model is not in the allowed model list'])
  })

  test('sensitive data cannot go to unverified providers even when allowlisted', () => {
    const decision = evaluateRoutingPolicy({ ...policy, providerAllowlist: ['zhipu', 'minimax'] }, { id: 'a', provider: 'minimax', modelId: 'glm-5.3-flash', hasSensitiveData: true })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toEqual(['sensitive data cannot be sent to unverified provider minimax'])

    const verified = evaluateRoutingPolicy({ ...policy, providerAllowlist: ['zhipu', 'minimax'] }, { id: 'b', provider: 'zhipu', modelId: 'glm-5.3-flash', hasSensitiveData: true })
    expect(verified.allowed).toBe(true)
  })

  test('allows compliant candidates and collects multiple reasons at once', () => {
    expect(evaluateRoutingPolicy(policy, { id: 'a', provider: 'anthropic', modelId: 'claude-test' }).allowed).toBe(true)
    const stacked = evaluateRoutingPolicy(policy, { id: 'a', provider: 'minimax', modelId: 'nope', hasSensitiveData: true })
    expect(stacked.reasons).toEqual([
      'provider minimax is not in the allowlist',
      'model nope is not in the allowed model list',
      'sensitive data cannot be sent to unverified provider minimax',
    ])
  })
})
