import { describe, expect, test } from 'bun:test'
import { getProviderCostCapability } from './provider-cost-capability'

describe('M6-01 provider cost capability registry', () => {
  test('returns verified cache capability only for explicitly registered providers', () => {
    for (const provider of ['anthropic', 'openai', 'deepseek', 'zhipu'] as const) {
      const capability = getProviderCostCapability(provider)
      expect(capability.verified).toBe(true)
      expect(capability.promptCache).toBe('supported')
      expect(capability.evidence).toBeTruthy()
    }
  })

  test('unregistered providers get a conservative unknown default, never an assumption', () => {
    for (const provider of ['minimax', 'doubao', 'qwen', 'custom', 'xiaomi'] as const) {
      const capability = getProviderCostCapability(provider)
      expect(capability).toEqual({ promptCache: 'unknown', tools: 'unknown', schemaMode: 'unknown', verified: false })
    }
  })
})
