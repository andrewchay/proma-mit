import { describe, expect, test } from 'bun:test'
import { estimateCost, resolvePrice } from './price-estimator'

/**
 * PH2-① 价格估算测试：provider 不给 cost 时估算非零费用。
 */

describe('价格估算（PH2-①）', () => {
  test('按模型前缀匹配价格', () => {
    expect(resolvePrice('claude-sonnet-4-5-20250929').outputPerMillionUsd).toBeGreaterThan(0)
    expect(resolvePrice('deepseek-v4-flash').inputPerMillionUsd).toBeGreaterThan(0)
    expect(resolvePrice('gpt-4o-2025').outputPerMillionUsd).toBeGreaterThan(0)
  })

  test('有 token 时估算出非零 cost', () => {
    const cost = estimateCost('deepseek-v4-flash', { inputTokens: 1_000_000, outputTokens: 500_000 })
    expect(cost).toBeGreaterThan(0)
  })

  test('未知模型用兜底价，token 为 0 时 cost 为 0', () => {
    expect(estimateCost('some-unknown-model', { inputTokens: 100_000 })).toBeGreaterThan(0)
    expect(estimateCost('x', { inputTokens: 0, outputTokens: 0 })).toBe(0)
  })
})
