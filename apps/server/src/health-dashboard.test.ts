import { describe, expect, it } from 'bun:test'
import { computeHealthDashboard, gradeLatency, gradeSuccessRate } from './health-dashboard'

describe('health-dashboard', () => {
  it('computeHealthDashboard 聚合贵慢重准 + 预算占用', () => {
    const dash = computeHealthDashboard({
      monthlyCostMicroUsd: 5_000_000, // $5
      p95LatencyMs: 4200,
      totalTokens: 3_000_000,
      totalRuns: 120,
      successRuns: 111,
      monthlyBudgetMicroUsd: 10_000_000, // $10
    })

    expect(dash.cost.monthlyMicroUsd).toBe(5_000_000)
    expect(dash.latency.p95Ms).toBe(4200)
    expect(dash.accuracy.successRate).toBeCloseTo(0.925, 2)
    expect(dash.budget.usedPercent).toBeCloseTo(50, 1)
  })

  it('无预算时 usedPercent 为 0', () => {
    const dash = computeHealthDashboard({
      monthlyCostMicroUsd: 100,
      p95LatencyMs: 100,
      totalTokens: 10,
      totalRuns: 1,
      successRuns: 1,
    })
    expect(dash.budget.monthlyLimitMicroUsd).toBeUndefined()
    expect(dash.budget.usedPercent).toBe(0)
  })

  it('gradeLatency 分档评分（慢=差）', () => {
    expect(gradeLatency(800)).toBe('good')
    expect(gradeLatency(2500)).toBe('warn')
    expect(gradeLatency(8000)).toBe('poor')
  })

  it('gradeSuccessRate 分档评分（准=好）', () => {
    expect(gradeSuccessRate(0.98)).toBe('good')
    expect(gradeSuccessRate(0.93)).toBe('warn')
    expect(gradeSuccessRate(0.85)).toBe('poor')
  })

  it('0 次运行时 successRate 与 volume 安全降级', () => {
    const dash = computeHealthDashboard({
      monthlyCostMicroUsd: 0, p95LatencyMs: 0, totalTokens: 0, totalRuns: 0, successRuns: 0,
    })
    expect(dash.accuracy.successRate).toBe(0)
    expect(dash.volume.totalRuns).toBe(0)
  })
})
