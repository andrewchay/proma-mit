import { describe, expect, it } from 'bun:test'
import { createExecutionBinder } from './execution-contract-binder'
import { ExecutionContractService, InMemoryExecutionContractStore } from './execution-contract-service'
import type { AgentExecutionLike } from './execution-contract-binder'

function makeExecution(overrides: Partial<AgentExecutionLike> = {}): AgentExecutionLike {
  return {
    id: 'exec-1', projectId: 'p1', entityType: 'task', entityId: 't1', agentId: 'emp-1',
    sessionId: 's1', executor: 'headless', status: 'queued', prompt: '',
    requestedPermissions: [], startedAt: Date.now(), ...overrides,
  }
}

describe('execution-contract-binder', () => {
  function makeBinder(opts: { id?: string; agentId?: string; entityId?: string } = {}) {
    const store = new InMemoryExecutionContractStore()
    const svc = new ExecutionContractService({ store })
    const binder = createExecutionBinder({
      service: svc,
      getSource: (e) => `task:${e.entityId}`,
      useExecutionIdAsContractId: true,
    })
    return { binder, store, svc }
  }

  it('onDispatch 创建 queued 契约，contractId 从 execution 派生', () => {
    const { binder, store } = makeBinder()
    const contract = binder.onDispatch(makeExecution({ id: 'exec-D1', entityId: 't-dispatch' }))

    expect(contract).not.toBeNull()
    expect(contract?.status).toBe('queued')
    expect(contract?.source).toBe('task:t-dispatch')
    expect(contract?.contractId).toContain('exec-D1')
    expect(store.get(contract!.contractId)).not.toBeNull()
  })

  it('完整生命周期：dispatch→start→complete 迁移到 completed 并回填 result', () => {
    const { binder, store } = makeBinder()
    binder.onDispatch(makeExecution({ id: 'exec-FULL', entityId: 't-full' }))

    const running = binder.onStart(makeExecution({ id: 'exec-FULL' }))
    const completed = binder.onComplete(makeExecution({ id: 'exec-FULL' }), '任务搞定')

    expect(running?.status).toBe('running')
    expect(completed?.status).toBe('completed')
    expect(completed?.result).toBe('任务搞定')
    expect(completed?.startedAt).toBeGreaterThan(0)
    expect(completed?.completedAt).toBeGreaterThan(0)
  })

  it('failed 契约不能原地重试（需新契约），stale 可回 running', () => {
    const { binder, store } = makeBinder()
    binder.onDispatch(makeExecution({ id: 'exec-FAIL', entityId: 't-fail' }))
    binder.onStart(makeExecution({ id: 'exec-FAIL' }))

    const failed = binder.onFail(makeExecution({ id: 'exec-FAIL' }), '模型超时')
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('模型超时')

    // failed → 不能原地重试：onRetry 返回 null，调用方应创建新契约
    expect(binder.onRetry(makeExecution({ id: 'exec-FAIL' }))).toBeNull()

    // stale → running 合法重试路径
    binder.onDispatch(makeExecution({ id: 'exec-STALE', entityId: 't-stale' }))
    const staleRunning = binder.onStart(makeExecution({ id: 'exec-STALE' }))
    // 模拟执行超时置 stale（这里直接通过 service 切换，验证 binder 的 onRetry 识别 stale）
    store.update({ ...staleRunning!, status: 'stale' as const })
    const retried = binder.onRetry(makeExecution({ id: 'exec-STALE' }))
    expect(retried?.status).toBe('running')
  })

  it('幂等：重复 complete 不抛错（终态已在 store）', () => {
    const { binder } = makeBinder()
    binder.onDispatch(makeExecution({ id: 'exec-IDEM', entityId: 't-idem' }))
    binder.onStart(makeExecution({ id: 'exec-IDEM' }))
    binder.onComplete(makeExecution({ id: 'exec-IDEM' }), '一次')
    const second = binder.onComplete(makeExecution({ id: 'exec-IDEM' }), '两次')
    expect(second?.status).toBe('completed')
  })

  it('binder 不改变 executor 来源（headless 透传）', () => {
    const { binder } = makeBinder()
    const contract = binder.onDispatch(makeExecution({ id: 'exec-EXEC', entityId: 't-exec', executor: 'workflow' }))
    expect(contract?.executor).toBe('workflow')
  })
})
