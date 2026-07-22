import { describe, expect, test } from 'bun:test'
import { PostgresUsageLedger, usageFromMessages } from './billing.ts'

describe('P3 usage ledger', () => {
  test('normalizes assistant usage and calculates a versioned cost', async () => {
    const queries: readonly unknown[][] = []
    const client = { query: async (_sql: string, params: readonly unknown[] = []) => {
      ;(queries as unknown[][]).push([...params])
      return { rows: [] }
    } }
    const ledger = new PostgresUsageLedger(client, [{
      provider: 'openai', modelId: 'model-a', effectiveAt: 0, inputPerMillionUsd: 2, outputPerMillionUsd: 10,
    }])
    const usage = usageFromMessages([{
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    }])
    expect(usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const record = await ledger.record({ tenantId: 'tenant', userId: 'user', taskId: 'task', sessionId: 'session', provider: 'openai', modelId: 'model-a', ...usage! })
    expect(record.costMicroUsd).toBe(12_000_000)
    expect(queries.length).toBe(1)
  })

  test('retains usage without inventing cost when no price exists', async () => {
    const ledger = new PostgresUsageLedger({ query: async () => ({ rows: [] }) }, [])
    const record = await ledger.record({ tenantId: 'tenant', userId: 'user', taskId: 'task', sessionId: 'session', provider: 'openai', modelId: 'unknown', inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(record.costMicroUsd).toBeUndefined()
  })

  test('rejects a task when the monthly budget is exhausted', async () => {
    const client = { query: async <Row extends Record<string, unknown>>() => ({ rows: [{ cost_microusd: 100 } as unknown as Row] }) }
    const ledger = new PostgresUsageLedger(client, [])
    await expect(ledger.assertTaskWithinBudget({ tenantId: 'tenant', userId: 'user' }, 'model', { monthlyCostMicroUsd: 100 }))
      .rejects.toThrow('本月预算已用尽')
  })

  test('rejects a task when the model monthly budget is exhausted', async () => {
    const client = { query: async <Row extends Record<string, unknown>>() => ({ rows: [{ cost_microusd: 80 } as unknown as Row] }) }
    const ledger = new PostgresUsageLedger(client, [])
    await expect(ledger.assertTaskWithinBudget({ tenantId: 'tenant', userId: 'user' }, 'model', { modelMonthlyCostMicroUsd: 80 }))
      .rejects.toThrow('该模型本月额度已用尽')
  })
})
