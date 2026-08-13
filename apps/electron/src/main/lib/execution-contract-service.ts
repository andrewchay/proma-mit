/**
 * Execution Contract Service — 任务无关的执行状态机
 *
 * 把「指派 → 执行 → 回写 → 考核」从项目任务解耦为通用契约状态机。
 * 允许注入 store 与生命周期钩子（onCreated / onTransition），
 * 使 Workflow、外部事件、远程触发都可复用同一条无人值守执行闭环。
 */
import { randomUUID } from 'node:crypto'
import type {
  CreateExecutionContractInput,
  ExecutionContract,
  ExecutionContractStatus,
} from '@gravitas/shared'

/** 契约持久化接口（当前实现均为内存同步；如需异步持久化可在接入 SQLite 时扩展） */
export interface ExecutionContractStore {
  create(contract: ExecutionContract): void
  get(contractId: string): ExecutionContract | null
  update(contract: ExecutionContract): void
  listByAgent(agentId: string): ExecutionContract[]
}

export interface ExecutionContractServiceOptions {
  store: ExecutionContractStore
  /** 契约创建后的生命周期钩子（如联动 AgentExecution、记录审计） */
  onCreated?: (contract: ExecutionContract) => void
  /** 状态迁移完成后的生命周期钩子（from 为迁移前状态） */
  onTransition?: (contract: ExecutionContract, from: ExecutionContractStatus) => void
}

const VALID_TRANSITIONS: Record<ExecutionContractStatus, ExecutionContractStatus[]> = {
  queued: ['running', 'cancelled', 'stale'],
  running: ['completed', 'failed', 'cancelled', 'stale'],
  completed: [],
  failed: [],
  cancelled: [],
  stale: ['running'],
}

/** 默认内存 store，供测试与轻量场景使用 */
export class InMemoryExecutionContractStore implements ExecutionContractStore {
  private readonly contracts = new Map<string, ExecutionContract>()

  create(contract: ExecutionContract): void {
    this.contracts.set(contract.contractId, contract)
  }
  get(contractId: string): ExecutionContract | null {
    return this.contracts.get(contractId) ?? null
  }
  update(contract: ExecutionContract): void {
    this.contracts.set(contract.contractId, contract)
  }
  listByAgent(agentId: string): ExecutionContract[] {
    return [...this.contracts.values()].filter((c) => c.agentId === agentId)
  }
}

export class ExecutionContractService {
  constructor(private readonly options: ExecutionContractServiceOptions) {}

  create<TPayload = unknown>(input: CreateExecutionContractInput<TPayload>): ExecutionContract<TPayload> {
    const contract: ExecutionContract<TPayload> = {
      ...input,
      contractId: input.contractId ?? randomUUID(),
      status: 'queued',
      createdAt: Date.now(),
    }
    this.options.store.create(contract)
    this.options.onCreated?.(contract)
    return contract
  }

  transition(contractId: string, to: ExecutionContractStatus): ExecutionContract | null {
    const store = this.options.store
    const contract = store.get(contractId)
    if (!contract) return null
    if (!VALID_TRANSITIONS[contract.status].includes(to)) {
      throw new Error(`非法契约状态迁移: ${contract.status} → ${to}`)
    }
    const from = contract.status
    contract.status = to
    if (to === 'running') {
      contract.startedAt ??= Date.now()
      contract.heartbeatAt = Date.now()
    }
    if (to === 'completed' || to === 'failed' || to === 'cancelled') {
      contract.completedAt = Date.now()
    }
    store.update(contract)
    this.options.onTransition?.(contract, from)
    return contract
  }

  listByAgent(agentId: string): ExecutionContract[] {
    return this.options.store.listByAgent(agentId)
  }
}

/** 判定契约已到某个状态（供 onTransition 消费） */
export function isContractInStatus(contract: ExecutionContract, status: ExecutionContractStatus): boolean {
  return contract.status === status
}
