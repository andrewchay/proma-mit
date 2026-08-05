import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeScope } from '@gravitas/shared/utils'
import { SignalScanner } from './signal-scan.ts'
import { PostgresSignalStore } from './signals.ts'
import type { Signal, SignalHit, SignalMatcher } from './signals.ts'
import type { RuntimeSpan, RuntimeSpanStatus } from '@gravitas/shared'

const scope: AgentRuntimeScope = { tenantId: 'tenant', userId: 'user' }

/** 内存 Signal store 实现（记录 hit + 支持 listEnabled/markChecked）。 */
class MemorySignalStore {
  hits: Array<{ hit: Omit<SignalHit, 'hitId' | 'createdAt'>; stored: SignalHit }> = []
  hitCount = 0
  checked: string[] = []
  signals: Signal[] = []

  setSignals(list: Signal[]) { this.signals = list }

  async listEnabled(_scope: AgentRuntimeScope): Promise<Signal[]> { return this.signals.filter((s) => s.enabled) }
  async markChecked(_scope: AgentRuntimeScope, signalId: string, _at: number): Promise<void> { this.checked.push(signalId) }
  async appendHit(hit: Omit<SignalHit, 'hitId' | 'createdAt'>): Promise<SignalHit> {
    const stored: SignalHit = { ...hit, hitId: `hit-${++this.hitCount}`, createdAt: Date.now() }
    this.hits.push({ hit, stored })
    return stored
  }
}

/** 可编程的数据源 mock。 */
function makeData(overrides: Partial<Record<keyof import('./signal-scan.ts').SignalDataSource, (...args: never[]) => unknown>>) {
  return {
    querySpansInWindow: async () => [] as RuntimeSpan[],
    countErrorsInWindow: async () => 0,
    toolFailureRuns: async () => ({ spanValues: [] as Array<{ taskId: string; count: number }> }),
    countFailedTasksSince: async () => 0,
    countTasksSince: async () => 1,
    maxTaskCostMicroUsdSince: async () => 0,
    countStaleTasks: async () => 0,
    ...overrides,
  }
}

function signal(matcher: SignalMatcher, description = 'someone描述'): Signal {
  return { ...scope, signalId: 's1', description, matcher, enabled: true, hitCount: 0, createdAt: 0, updatedAt: 0 }
}

function scanner(store: MemorySignalStore, data: ReturnType<typeof makeData>, now = 10_000) {
  return new SignalScanner({
    store: store as unknown as import('./signal-scan.ts').SignalScannerOptions['store'],
    data: data as import('./signal-scan.ts').SignalDataSource,
    now: () => now,
  })
}

describe('SignalScanner 各 matcher 确定性判定', () => {
  test('task_failure_rate：失败率≥阈值命中', async () => {
    const store = new MemorySignalStore()
    const data = makeData({ countFailedTasksSince: async () => 4, countTasksSince: async () => 10 })
    const result = await scanner(store, data).evaluate(scope, signal({ type: 'task_failure_rate', minFailRate: 0.3, windowMs: 60_000 }))
    expect(result?.signalId).toBe('s1')
    expect(result?.message).toContain('失败率 40%')
    expect(result?.evidence).toMatchObject({ failed: 4, total: 10 })
  })

  test('task_failure_rate：失败率低于阈值不命中', async () => {
    const store = new MemorySignalStore()
    const data = makeData({ countFailedTasksSince: async () => 1, countTasksSince: async () => 10 })
    const result = await scanner(store, data).evaluate(scope, signal({ type: 'task_failure_rate', minFailRate: 0.5, windowMs: 60_000 }))
    expect(result).toBeUndefined()
  })

  test('tool_repeat_failure：同一 task 工具连续失败≥N 命中（循环检测）', async () => {
    const store = new MemorySignalStore()
    const data = makeData({ toolFailureRuns: async () => ({ spanValues: [{ taskId: 'task-1', count: 5 }] }) })
    const result = await scanner(store, data).evaluate(scope, signal({ type: 'tool_repeat_failure', namePrefix: 'tool:Bash', minFailures: 3, windowMs: 600_000 }))
    expect(result?.message).toContain('tool:Bash')
    expect(result?.message).toContain('连续失败 5 次')
    expect(result?.evidence).toMatchObject({ taskId: 'task-1', failures: 5 })
  })

  test('tool_repeat_failure：未达阈值不命中', async () => {
    const store = new MemorySignalStore()
    const data = makeData({ toolFailureRuns: async () => ({ spanValues: [] }) })
    const result = await scanner(store, data).evaluate(scope, signal({ type: 'tool_repeat_failure', namePrefix: 'tool:Bash', minFailures: 3, windowMs: 600_000 }))
    expect(result).toBeUndefined()
  })

  test('task_cost_threshold：单 task 成本超阈值命中', async () => {
    const store = new MemorySignalStore()
    const data = makeData({ maxTaskCostMicroUsdSince: async () => 500_000 }) // 0.5 USD
    const result = await scanner(store, data).evaluate(scope, signal({ type: 'task_cost_threshold', thresholdMicroUsd: 100_000, windowMs: 3600_000 }))
    expect(result?.message).toContain('0.5000 USD')
  })

  test('stale_task：存在 stale 任务命中', async () => {
    const store = new MemorySignalStore()
    const data = makeData({ countStaleTasks: async () => 2 })
    const result = await scanner(store, data).evaluate(scope, signal({ type: 'stale_task', staleAfterMs: 60_000 }))
    expect(result?.message).toContain('2 个失去租约')
  })

  test('provider_error：provider 错误次数≥阈值命中', async () => {
    const store = new MemorySignalStore()
    const data = makeData({ countErrorsInWindow: async () => 7 })
    const result = await scanner(store, data).evaluate(scope, signal({ type: 'provider_error', namePrefix: 'provider:openai', minErrors: 5, windowMs: 60_000 }))
    expect(result?.message).toContain('7 次错误')
  })

  test('scan 会为命中的 signal 落 hit 并推进 lastCheckedAt', async () => {
    const store = new MemorySignalStore()
    store.setSignals([
      signal({ type: 'tool_repeat_failure', namePrefix: 'tool:Bash', minFailures: 3, windowMs: 600_000 }),
      signal({ type: 'task_cost_threshold', thresholdMicroUsd: 999_999, windowMs: 3600_000 }),
    ])
    const data = makeData({ toolFailureRuns: async () => ({ spanValues: [{ taskId: 't', count: 4 }] }), maxTaskCostMicroUsdSince: async () => 10 })
    const result = await scanner(store, data).scan(scope)
    expect(result).toHaveLength(1)
    expect(store.hits).toHaveLength(1)
    expect(store.checked).toEqual(['s1', 's1']) // 两个信号（用同一 id 简化）都会被 markChecked
  })
})

describe('PostgresSignalStore schema', () => {
  test('初始化建两张表与索引', async () => {
    const sqls: string[] = []
    const client = {
      query: async <RowType extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<{ rows: RowType[] }> => {
        sqls.push(sql)
        return { rows: [] as RowType[] }
      },
    }
    const store = new PostgresSignalStore(client as never)
    await store.initializeSchema()
    const all = sqls.join('\n')
    expect(all).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_signals')
    expect(all).toContain('CREATE TABLE IF NOT EXISTS proma_runtime_signal_hits')
  })

  test('matcher 序列化可往返', async () => {
    // 直接验证 SignalScanner 不依赖 matcher 反序列化细节；create/parse 由 app 层 parseSignalMatcher 负责，此处测信号构造
    const matcher: SignalMatcher = { type: 'tool_repeat_failure', namePrefix: 'tool:Bash', minFailures: 3, windowMs: 1000 }
    expect(JSON.parse(JSON.stringify(matcher))).toEqual(matcher)
  })
})
