import { describe, expect, test } from 'bun:test'
import type { ModelPricing } from './cost-model'
import { runRoutingBenchmark, type RoutingScenario } from './routing-benchmark'

const pricing: ModelPricing = {
  currency: 'USD',
  source: 'unit-test fixture @ 2026-09-22',
  inputPerMTokens: 3,
  outputPerMTokens: 12,
  cacheReadPerMTokens: 0.6,
}

const usage = { inputTokens: 200_000, outputTokens: 20_000, cacheReadTokens: 400_000 }

const scenarios: RoutingScenario[] = [
  {
    id: 'sensitive-request',
    candidates: [
      { id: 'unverified-first', provider: 'minimax', modelId: 'm', hasSensitiveData: true },
      { id: 'verified', provider: 'zhipu', modelId: 'glm-5.3-flash', hasSensitiveData: true },
    ],
    policy: { providerAllowlist: ['zhipu'] },
    usage,
  },
  {
    id: 'plain-request',
    candidates: [
      { id: 'cache-unknown', provider: 'custom', modelId: 'm' },
      { id: 'cache-supported', provider: 'anthropic', modelId: 'claude-test' },
    ],
    policy: { providerAllowlist: ['anthropic', 'custom'] },
    usage,
  },
]

describe('M6-05 routing benchmark (offline)', () => {
  test('reports cost savings, privacy violations, and fully explained decisions', () => {
    const report = runRoutingBenchmark({ scenarios, pricing })

    expect(report.benchmarkId).toBe('routing-policy-benchmark')
    expect(report.autoEnabled).toBe(false)

    const sensitive = report.scenarios[0]!
    // baseline（取第一个候选）选中了过不了 policy 的 unverified-first：记一次违规，无成本
    expect(sensitive.privacyViolations).toBe(1)
    expect(sensitive.baselineId).toBe('unverified-first')
    expect(sensitive.routedId).toBe('verified')

    const plain = report.scenarios[1]!
    // unknown-cache 候选按 miss 计价后更贵，路由选择支持缓存的候选
    expect(plain.routedId).toBe('cache-supported')
    expect(plain.savingsRate).toBeGreaterThan(0)
    expect(plain.privacyViolations).toBe(0)

    expect(report.privacyViolations).toBe(1)
    // scenario 1 的 baseline 违规计 0 成本，全局总额不可直接比大小；
    // 有效断言是合规场景内 baseline（unknown-cache）比 routed 贵，且 savingsRate 与分项一致。
    expect(plain.baselineCost).toBeGreaterThan(plain.routedCost)
    const recomputed = 1 - report.totalRoutedCost / report.totalBaselineCost
    expect(report.savingsRate).toBeCloseTo(recomputed, 10)
    expect(report.scenarios.every((scenario) => scenario.allDecisionsExplained)).toBe(true)
  })

  test('is deterministic for identical scenario inputs', () => {
    expect(runRoutingBenchmark({ scenarios, pricing })).toEqual(runRoutingBenchmark({ scenarios, pricing }))
  })
})
