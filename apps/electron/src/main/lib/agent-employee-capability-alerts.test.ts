import { expect, test } from 'bun:test'
import { buildCapabilityAlerts } from './agent-employee-capability-alerts'
import type { AgentEmployeeCapabilityHealth } from './project-types'

function health(overrides: Partial<AgentEmployeeCapabilityHealth> = {}): AgentEmployeeCapabilityHealth {
  return { versionId: 'v1', windowDays: 30, executionCount: 6, reworkRate: 0.1, failureRate: 0, cancellationRate: 0, decidedSampleCount: 6, executionDecidedSampleCount: 6, humanJudgmentEligibleCount: 0, humanAcceptedCount: 0, humanChangesRequestedCount: 0, sampleSufficient: true, executionSampleSufficient: true, reworkNoiseFloor: null, historicalReworkRate: null, noiseFloorMode: 'fixed_fallback', noiseFloorWindowCount: 0, reworkDeltaExceedsNoiseFloor: null, lastExecutedAt: Date.now(), comparisonComparable: false, ...overrides }
}

test('样本不足时不产生质量告警，只提示观察不足', () => {
  const alerts = buildCapabilityAlerts({ health: [health({ sampleSufficient: false, decidedSampleCount: 1, executionSampleSufficient: false, executionDecidedSampleCount: 1, failureRate: 1, reworkRate: 1 })] })
  expect(alerts.some((item) => item.code === 'consecutive_failures')).toBe(false)
  expect(alerts.some((item) => item.code === 'rework_spike')).toBe(false)
})

test('执行失败告警与 Owner 返工告警分别使用各自的样本门槛', () => {
  const alerts = buildCapabilityAlerts({ health: [health({ sampleSufficient: false, executionSampleSufficient: true, executionDecidedSampleCount: 6, failureRate: 1, reworkRate: 0.8 })] })
  expect(alerts.map((item) => item.code)).toContain('consecutive_failures')
  expect(alerts.map((item) => item.code)).not.toContain('rework_spike')
  expect(alerts.find((item) => item.code === 'consecutive_failures')?.evidence).toContain('执行样本 6 条')
})

test('历史波动范围内的返工变化不产生质量告警', () => {
  const alerts = buildCapabilityAlerts({ health: [health({
    reworkRate: 0.6,
    historicalReworkRate: 0.4,
    reworkNoiseFloor: 0.2,
    noiseFloorMode: 'historical',
  })] })
  expect(alerts.some((item) => item.code === 'rework_spike')).toBe(false)
})

test('超过历史均值加噪声地板且固定阈值时产生返工告警', () => {
  const alerts = buildCapabilityAlerts({ health: [health({
    reworkRate: 0.8,
    historicalReworkRate: 0.4,
    reworkNoiseFloor: 0.2,
    noiseFloorMode: 'historical',
  })] })
  expect(alerts.find((item) => item.code === 'rework_spike')?.evidence).toContain('历史均值 40.0%')
})

test('连续失败与返工率激增生成告警', () => {
  const alerts = buildCapabilityAlerts({ health: [health({ failureRate: 1, reworkRate: 0.6 })] })
  expect(alerts.some((item) => item.code === 'consecutive_failures')).toBe(true)
  expect(alerts.some((item) => item.code === 'rework_spike')).toBe(true)
  expect(alerts.every((item) => item.severity === 'warning')).toBe(true)
})

test('无样本或长时间无执行只提示观察不足', () => {
  const noSamples = buildCapabilityAlerts({ health: [health({ decidedSampleCount: 0, executionDecidedSampleCount: 0, failureRate: null, reworkRate: null })] })
  expect(noSamples).toEqual([expect.objectContaining({ code: 'stale_observation', severity: 'info' })])

  const stale = buildCapabilityAlerts({ health: [health({ lastExecutedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 })], staleDays: 21 })
  expect(stale.some((item) => item.code === 'stale_observation' && item.message.includes('21 天'))).toBe(true)
})

test('健康版本不产生任何告警', () => {
  expect(buildCapabilityAlerts({ health: [health()] })).toHaveLength(0)
})
