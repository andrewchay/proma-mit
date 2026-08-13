/**
 * Execution Contract 统一执行契约
 *
 * 把「指派 → 执行 → 回写 → 考核」从项目任务解耦为通用状态机：
 * source 用 task:xxx / schedule:xxx / event:xxx 描述来源，不再强绑定项目任务。
 * 契约层种子：未来 Workflow、外部事件、远程触发都复用同一条无人值守执行闭环。
 */

export const EXECUTION_CONTRACT_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'stale'] as const
export type ExecutionContractStatus = (typeof EXECUTION_CONTRACT_STATUSES)[number]

export const EXECUTION_CONTRACT_EXECUTORS = ['headless', 'workflow'] as const
export type ExecutionContractExecutor = (typeof EXECUTION_CONTRACT_EXECUTORS)[number]

export interface ExecutionContract<TPayload = unknown, TResult = unknown> {
  contractId: string
  agentId: string
  /** 来源实体描述（如 task / schedule / event），不再强绑定项目任务 */
  source: string
  sourceId?: string
  executor: ExecutionContractExecutor
  status: ExecutionContractStatus
  payload: TPayload
  result?: TResult
  error?: string
  heartbeatAt?: number
  createdAt: number
  startedAt?: number
  completedAt?: number
}

export interface CreateExecutionContractInput<TPayload = unknown> {
  /** 可选：调用方可传入稳定契约 ID（如从外部实体 ID 派生）；缺省由服务端生成 UUID */
  contractId?: string
  agentId: string
  source: string
  sourceId?: string
  executor: ExecutionContractExecutor
  payload: TPayload
}

/** 终态判定：终态后不再允许迁移 */
export function isExecutionContractTerminal(status: ExecutionContractStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale'
}

/** 已知来源的展示标签；未知来源原样返回 */
const SOURCE_LABELS: Record<string, string> = {
  task: '项目管理任务',
  schedule: '定时触发',
  event: '事件触发',
  manual: '手动执行',
}

export function normalizeSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}
