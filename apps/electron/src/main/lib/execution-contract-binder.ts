/**
 * Execution Contract Binder — 把 AI 员工执行生命周期桥到统一契约层
 *
 * 从 AgentExecution 派生稳定 contractId，把 dispatch/start/complete/fail/retry
 * 映射为 Execution Contract 状态迁移。使既有执行闭环的数据可被契约层消费，
 * 未来 Workflow/事件/定时等来源复用同一状态机。
 */
import type {
  AgentExecutionStatus,
} from './project-types'
import type { ExecutionContractService } from './execution-contract-service'
import type {
  ExecutionContract,
  ExecutionContractExecutor,
} from '@gravitas/shared'

/** 与 store 中 AgentExecution 语义一致的结构子集，避免强依赖 store 返回类型 */
export interface AgentExecutionLike {
  id: string
  projectId: string
  entityType: 'task' | 'subTask'
  entityId: string
  agentId: string
  sessionId: string
  executor?: 'headless' | 'workflow'
  status: string
  prompt: string
  requestedPermissions?: string[]
  resultSummary?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

export interface ExecutionBinderOptions {
  service: ExecutionContractService
  /** 由 execution 派生契约 source（如 task:xxx） */
  getSource: (execution: AgentExecutionLike) => string
  /** 直接用 execution.id 作为 contractId（默认派生 exec:{id}，开启后共用同一 ID） */
  useExecutionIdAsContractId?: boolean
}

export interface ExecutionBinder {
  onDispatch(execution: AgentExecutionLike): ExecutionContract | null
  onStart(execution: AgentExecutionLike): ExecutionContract | null
  onComplete(execution: AgentExecutionLike, result: string): ExecutionContract | null
  onFail(execution: AgentExecutionLike, error: string): ExecutionContract | null
  onRetry(execution: AgentExecutionLike): ExecutionContract | null
}

function contractIdFor(execution: AgentExecutionLike, useExecId: boolean): string {
  return useExecId ? execution.id : `exec:${execution.id}`
}

function executorFor(execution: AgentExecutionLike): ExecutionContractExecutor {
  return execution.executor === 'workflow' ? 'workflow' : 'headless'
}

/**
 * 把 execution 状态映射为契约迁移。非法迁移（如从终态再动）会被契约服务抛错，
 * 但此处对"重复 complete / 重复 fail"做幂等兜底，符合既有 handleExecutionComplete/Error 的防重入语义。
 */
export function createExecutionBinder(options: ExecutionBinderOptions): ExecutionBinder {
  const { service, getSource, useExecutionIdAsContractId = false } = options

  const getOrCreate = (execution: AgentExecutionLike): ExecutionContract | null => {
    const id = contractIdFor(execution, useExecutionIdAsContractId)
    const existing = service.listByAgent(execution.agentId).find((c) => c.contractId === id)
    if (existing) return { ...existing } as ExecutionContract // 快照，避免外部别名污染 store
    return service.create({
      contractId: id,
      agentId: execution.agentId,
      source: getSource(execution),
      sourceId: execution.entityId,
      executor: executorFor(execution),
      payload: {
        taskId: execution.entityId,
        projectId: execution.projectId,
        entityType: execution.entityType,
        requestedPermissions: execution.requestedPermissions ?? [],
      },
    })
  }

  return {
    onDispatch(execution) {
      return getOrCreate(execution)
    },
    onStart(execution) {
      const contract = getOrCreate(execution)
      if (!contract) return null
      try {
        const migrated = service.transition(contract.contractId, 'running')
        return migrated ? { ...migrated } as ExecutionContract : null
      } catch {
        return contract // 已在 running，幂等返回
      }
    },
    onComplete(execution, result) {
      const contract = getOrCreate(execution)
      if (!contract) return null
      // 幂等：已是终态直接回填 result
      if (contract.status === 'completed') return { ...contract, result } as ExecutionContract
      try {
        const migrated = service.transition(contract.contractId, 'completed')
        return migrated ? { ...migrated, result } as ExecutionContract : null
      } catch {
        // transition 失败说明契约已处于终态（重复完成场景），幂等回填 result
        return { ...contract, result } as ExecutionContract
      }
    },
    onFail(execution, error) {
      const contract = getOrCreate(execution)
      if (!contract) return null
      if (contract.status === 'failed') return { ...contract, error } as ExecutionContract
      try {
        const migrated = service.transition(contract.contractId, 'failed')
        return migrated ? { ...migrated, error } as ExecutionContract : null
      } catch {
        return null
      }
    },
    onRetry(execution) {
      const contract = getOrCreate(execution)
      if (!contract) return null
      // 仅 stale（超时/僵尸）可合法回到 running 复用同一契约
      if (contract.status === 'stale') {
        try {
          const migrated = service.transition(contract.contractId, 'running')
          return migrated ? { ...migrated } as ExecutionContract : null
        } catch {
          return null
        }
      }
      if (contract.status === 'running') return contract
      // failed / cancelled / completed 不能原地重试：调用方应创建新契约（新执行）
      return null
    },
  }
}

export type { AgentExecutionStatus }
