import { expect, test } from 'bun:test'
import { calculateProjectFlowMetrics } from './project-flow-metrics'

test('流动指标只用权威任务时间戳计算在制品、吞吐、周期和 SLE 超时', () => {
  const day = 86_400_000
  const now = 20 * day
  const metrics = calculateProjectFlowMetrics(
    [
      { id: 'active', status: 'in_progress', createdAt: 10 * day, startDate: 11 * day },
      { id: 'waiting', status: 'pending', createdAt: 18 * day },
      { id: 'done', status: 'completed', createdAt: day, startDate: 2 * day, completedAt: 7 * day },
      { id: 'draft', status: 'draft', createdAt: day },
    ],
    new Set(['waiting']),
    5,
    now,
  )
  expect(metrics).toEqual({
    workInProgress: 1,
    waiting: 1,
    throughput30Days: 1,
    averageCycleTimeDays: 5,
    oldestWorkItemAgeDays: 9,
    serviceLevelBreaches: 1,
  })
})
