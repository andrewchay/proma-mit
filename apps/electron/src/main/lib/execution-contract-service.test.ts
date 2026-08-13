import { describe, expect, it, mock } from 'bun:test'
import { ExecutionContractService } from './execution-contract-service'
import type { ExecutionContract, ExecutionContractStatus } from '@gravitas/shared'

/** 内存版 ContractStore，模拟契约持久化 + 生命周期钩子记录 */
class MemoryContractStore {
  contracts = new Map<string, ExecutionContract>()
  created: Array<string> = []
  transitions: Array<{ id: string; from: ExecutionContractStatus; to: ExecutionContractStatus }> = []

  create(c: ExecutionContract): void {
    this.contracts.set(c.contractId, c)
    this.created.push(c.contractId)
  }
  get(id: string): ExecutionContract | null {
    return this.contracts.get(id) ?? null
  }
  update(c: ExecutionContract): void {
    this.contracts.set(c.contractId, c)
  }
  listByAgent(agentId: string): ExecutionContract[] {
    return [...this.contracts.values()].filter((c) => c.agentId === agentId)
  }
}

describe('ExecutionContractService', () => {
  it('create 生成 queued 契约并绑定钩子', () => {
    const store = new MemoryContractStore()
    const onCreated = mock((c: ExecutionContract) => {})
    const svc = new ExecutionContractService({ store, onCreated })

    const contract = svc.create({ agentId: 'emp-1', source: 'task', sourceId: 't1', executor: 'headless', payload: { taskId: 't1' } })

    expect(contract.status).toBe('queued')
    expect(contract.contractId).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.created).toContain(contract.contractId)
    expect(onCreated).toHaveBeenCalled()
  })

  it('transition queued→running→completed 合法且写时间戳', () => {
    const store = new MemoryContractStore()
    const svc = new ExecutionContractService({ store })
    const contract = svc.create({ agentId: 'emp-1', source: 'task', executor: 'headless', payload: {} })

    const running = svc.transition(contract.contractId, 'running')
    expect(running?.status).toBe('running')
    expect(running?.startedAt).toBeGreaterThan(0)

    const completed = svc.transition(contract.contractId, 'completed')
    expect(completed?.status).toBe('completed')
    expect(completed?.completedAt).toBeGreaterThan(0)
  })

  it('非法迁移 queued→completed 抛错', () => {
    const store = new MemoryContractStore()
    const svc = new ExecutionContractService({ store })
    const contract = svc.create({ agentId: 'emp-1', source: 'task', executor: 'headless', payload: {} })

    expect(() => svc.transition(contract.contractId, 'completed')).toThrow(/非法契约状态迁移/)
  })

  it('终态后拒绝再次迁移（completed→running）', () => {
    const store = new MemoryContractStore()
    const svc = new ExecutionContractService({ store })
    const contract = svc.create({ agentId: 'emp-1', source: 'task', executor: 'headless', payload: {} })
    svc.transition(contract.contractId, 'running')
    svc.transition(contract.contractId, 'completed')

    expect(() => svc.transition(contract.contractId, 'running')).toThrow(/非法契约状态迁移/)
  })

  it('切换状态触发 onTransition 钩子', () => {
    const store = new MemoryContractStore()
    const onTransition = mock((_c: ExecutionContract, _from: ExecutionContractStatus) => {})
    const svc = new ExecutionContractService({ store, onTransition })
    const contract = svc.create({ agentId: 'emp-1', source: 'task', executor: 'headless', payload: {} })

    svc.transition(contract.contractId, 'running')
    expect(onTransition).toHaveBeenCalledTimes(1)
    expect(onTransition.mock.calls[0]![1]).toBe('queued')
  })

  it('transition 不存在的契约返回 null', () => {
    const store = new MemoryContractStore()
    const svc = new ExecutionContractService({ store })
    expect(svc.transition('no-such', 'completed')).toBeNull()
  })
})
