import { expect, test } from 'bun:test'
import { calculateReworkNoiseFloor, type OwnerJudgmentObservation } from './agent-employee-noise-floor'

const DAY_MS = 24 * 60 * 60 * 1000

test('Given 不足的 Owner 判断 When 估算波动 Then 返回固定阈值并标记回退', () => {
  const result = calculateReworkNoiseFloor([{ at: 99 * DAY_MS, outcome: 'changes_requested' }], 100 * DAY_MS)
  expect(result).toEqual({ mode: 'fixed_fallback', meanReworkRate: null, standardDeviation: null, alertThreshold: 0.5, windowCount: 0 })
})

test('Given 90 天稳定的 Owner 判断 When 估算波动 Then 历史均值与标准差如实计算', () => {
  const observations: OwnerJudgmentObservation[] = Array.from({ length: 90 * 5 }, (_, index) => ({
    at: (10 + Math.floor(index / 5)) * DAY_MS,
    outcome: 'business_accepted',
  }))
  const result = calculateReworkNoiseFloor(observations, 100 * DAY_MS)
  expect(result.mode).toBe('historical')
  expect(result.windowCount).toBeGreaterThanOrEqual(5)
  expect(result.meanReworkRate).toBe(0)
  expect(result.standardDeviation).toBe(0)
})

test('Given Owner 退回率随时间变化 When 估算波动 Then 噪声地板不低估观测波动', () => {
  const observations: OwnerJudgmentObservation[] = Array.from({ length: 90 * 5 }, (_, index) => ({
    at: (10 + Math.floor(index / 5)) * DAY_MS,
    outcome: Math.floor(index / 5) % 2 === 0 ? 'business_accepted' : 'changes_requested',
  }))
  const result = calculateReworkNoiseFloor(observations, 100 * DAY_MS)
  expect(result.mode).toBe('historical')
  expect(result.standardDeviation).toBeGreaterThan(0)
})
