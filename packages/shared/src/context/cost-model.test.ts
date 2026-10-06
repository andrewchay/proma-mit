import { describe, expect, test } from 'bun:test'
import { estimateRequestCost } from './cost-model'
import { getProviderCostCapability } from './provider-cost-capability'

const pricing = {
  currency: 'USD' as const,
  source: 'unit-test fixture @ 2026-09-22',
  inputPerMTokens: 3,
  outputPerMTokens: 12,
  cacheReadPerMTokens: 0.6,
  cacheWritePerMTokens: 3.75,
}

describe('M6-02 cost model', () => {
  test('prices supported-cache providers with discounted cache reads', () => {
    const estimate = estimateRequestCost({
      provider: 'anthropic',
      modelId: 'claude-test',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      retries: 0,
    }, pricing)

    expect(estimate.inputCost).toBe(3)
    expect(estimate.cacheReadCost).toBe(0.6)
    expect(estimate.assumptions).toEqual([])
    expect(estimate.priceSource).toBe(pricing.source)
    expect(estimate.total).toBeCloseTo(3 + 1.2 + 0.6, 10)
  })

  test('unknown cache capability is priced as full input and recorded as an assumption', () => {
    const estimate = estimateRequestCost({
      provider: 'custom',
      modelId: 'mystery',
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 14_000,
    }, pricing)

    // 14k cache-read tokens 按全价 input 计入：1_000 + 14_000 = 15_000 tokens
    expect(estimate.inputCost).toBeCloseTo((15_000 / 1_000_000) * 3, 10)
    expect(estimate.cacheReadCost).toBe(0)
    expect(estimate.assumptions[0]).toContain('cache capability is unknown: cache-read tokens priced as full input')
  })

  test('supported provider without cache price entries falls back to the input rate with a note', () => {
    const estimate = estimateRequestCost({
      provider: 'anthropic',
      modelId: 'claude-test',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    }, { ...pricing, cacheReadPerMTokens: undefined })

    expect(estimate.cacheReadCost).toBe(3)
    expect(estimate.assumptions[0]).toContain('cacheReadPerMTokens not provided')
  })

  test('retries are priced as full extra turns', () => {
    const single = estimateRequestCost({ provider: 'anthropic', modelId: 'm', inputTokens: 1_000_000, outputTokens: 100_000 }, pricing)
    const retried = estimateRequestCost({ provider: 'anthropic', modelId: 'm', inputTokens: 1_000_000, outputTokens: 100_000, retries: 2 }, pricing)
    expect(retried.retryCost).toBeCloseTo(2 * (single.inputCost + single.outputCost), 10)
    expect(retried.assumptions.some((assumption) => assumption.startsWith('retries (2)'))).toBe(true)
  })

  test('fails closed on invalid inputs and missing price source', () => {
    expect(() => estimateRequestCost({ provider: 'anthropic', modelId: 'm', inputTokens: -1, outputTokens: 0 }, pricing)).toThrow('inputTokens')
    expect(() => estimateRequestCost({ provider: 'anthropic', modelId: 'm', inputTokens: 0, outputTokens: 0 }, { ...pricing, source: ' ' })).toThrow('pricing.source')
  })

  test('capability injection is replaceable', () => {
    const capability = { ...getProviderCostCapability('zhipu'), promptCache: 'unknown' as const }
    const estimate = estimateRequestCost({ provider: 'zhipu', modelId: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000 }, pricing, capability)
    expect(estimate.inputCost).toBeCloseTo((1_000 / 1_000_000) * 3, 10)
  })
})
