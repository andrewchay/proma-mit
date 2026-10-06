import { describe, expect, test } from 'bun:test'
import { shouldTriggerCompaction } from './compaction-trigger'

describe('M5-03 compaction trigger policy', () => {
  test('triggers when the token estimate reaches the budget', () => {
    const decision = shouldTriggerCompaction({ tokenEstimate: 900, tokenBudget: 900 })
    expect(decision.trigger).toBe(true)
    expect(decision.reasons).toEqual(['token estimate 900 reached budget 900'])
  })

  test('triggers on turn and retry thresholds with defaults', () => {
    const byTurns = shouldTriggerCompaction({ tokenEstimate: 10, tokenBudget: 900, turnsSinceLastCompaction: 20 })
    expect(byTurns.trigger).toBe(true)
    expect(byTurns.reasons[0]).toContain('turns since last compaction (20) reached threshold 20')

    const byRetries = shouldTriggerCompaction({ tokenEstimate: 10, tokenBudget: 900, retryCount: 3 })
    expect(byRetries.trigger).toBe(true)
    expect(byRetries.reasons[0]).toContain('retry count (3) reached threshold 3')
  })

  test('does not trigger below every threshold and supports custom thresholds', () => {
    expect(shouldTriggerCompaction({ tokenEstimate: 100, tokenBudget: 900, turnsSinceLastCompaction: 3, retryCount: 1 }).trigger).toBe(false)
    const custom = shouldTriggerCompaction({ tokenEstimate: 10, tokenBudget: 900, turnsSinceLastCompaction: 2, turnThreshold: 2 })
    expect(custom.trigger).toBe(true)
  })

  test('zero budget never triggers the budget rule on its own', () => {
    expect(shouldTriggerCompaction({ tokenEstimate: 5000, tokenBudget: 0 }).trigger).toBe(false)
  })
})
