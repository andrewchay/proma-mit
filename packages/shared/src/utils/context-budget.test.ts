import { describe, expect, test } from 'bun:test'
import { calculateContextBudget } from './context-budget'

describe('上下文预算', () => {
  test('在预留输出和安全余量前触发压缩，而不是等窗口满格', () => {
    expect(calculateContextBudget({
      contextWindow: 1_000_000,
      inputTokens: 840_000,
      requestedOutputTokens: 128_000,
      safetyBufferTokens: 32_000,
    })).toMatchObject({
      inputBudgetTokens: 840_000,
      shouldCompact: false,
    })

    expect(calculateContextBudget({
      contextWindow: 1_000_000,
      inputTokens: 840_001,
      requestedOutputTokens: 128_000,
      safetyBufferTokens: 32_000,
    })).toMatchObject({
      inputBudgetTokens: 840_000,
      shouldCompact: true,
    })
  })
})
