import { describe, expect, test } from 'bun:test'
import { PostgresRuntimeMetrics } from './metrics.ts'

describe('P5 runtime metrics', () => {
  test('aggregates task and usage metrics within the caller scope', async () => {
    let calls = 0
    const client = { query: async <Row extends Record<string, unknown>>() => {
      const value = calls++ === 0
        ? { running_tasks: '1', completed_tasks: '2', failed_tasks: '3', cancelled_tasks: '4' }
        : { input_tokens: '5', output_tokens: '6', cost_microusd: '7' }
      return { rows: [value as unknown as Row] }
    } }
    const metrics = new PostgresRuntimeMetrics(client)
    expect(await metrics.get({ tenantId: 'tenant', userId: 'user' })).toEqual({ runningTasks: 1, completedTasks24h: 2, failedTasks24h: 3, cancelledTasks24h: 4, inputTokens24h: 5, outputTokens24h: 6, costMicroUsd24h: 7 })
  })
})
