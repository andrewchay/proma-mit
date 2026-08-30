/** Proactive Scheduler 的持久化契约。 */

import type { AgentRuntime, PromaPermissionMode } from './agent'

export type ProactiveScheduleSpec =
  | { type: 'at'; runAt: number }
  | { type: 'interval'; intervalMs: number }
  /** Cron 表达式始终配合 IANA 时区保存，避免机器时区变更改变执行语义。 */
  | { type: 'cron'; expression: string; timezone: string }

export type ProactiveRunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'

export interface ProactiveSchedule {
  id: string
  title: string
  /** 目标会话 ID；newSession=true 时运行时新建会话后回填 */
  sessionId?: string
  workspaceId?: string
  channelId: string
  modelId?: string
  runtime: Extract<AgentRuntime, 'proma' | 'ai-sdk'>
  prompt: string
  /** 可选的 Routine 实例绑定；调度仍保留自身运行记录。 */
  routineInstanceId?: string
  schedule: ProactiveScheduleSpec
  /** 是否在每次运行时新建会话执行（默认 false = 复用目标会话） */
  newSession?: boolean
  /** 主动任务默认安全模式；持久化创建时不得默认提升权限。 */
  permissionMode: Extract<PromaPermissionMode, 'safe' | 'plan'>
  enabled: boolean
  /** 连续失败计数达到安全阈值后会自动暂停，避免无人值守任务持续消耗额度。 */
  consecutiveFailures: number
  nextRunAt?: number
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface CreateProactiveScheduleInput {
  title: string
  /** newSession=true 时可为空（运行时创建新会话） */
  sessionId?: string
  workspaceId?: string
  channelId: string
  modelId?: string
  runtime: Extract<AgentRuntime, 'proma' | 'ai-sdk'>
  prompt: string
  routineInstanceId?: string
  schedule: ProactiveScheduleSpec
  /** 新建会话执行：每次运行时创建新 Agent 会话（默认 false） */
  newSession?: boolean
  permissionMode?: Extract<PromaPermissionMode, 'safe' | 'plan'>
}

/**
 * 用户显式编辑已创建的 Proactive 定时任务。
 * 运行记录和创建时间不可通过此输入改写。
 */
export interface UpdateProactiveScheduleInput {
  title: string
  sessionId?: string
  workspaceId?: string
  channelId: string
  modelId?: string
  runtime: Extract<AgentRuntime, 'proma' | 'ai-sdk'>
  prompt: string
  routineInstanceId?: string
  schedule: ProactiveScheduleSpec
  newSession?: boolean
  permissionMode: Extract<PromaPermissionMode, 'safe' | 'plan'>
  enabled: boolean
}

export interface ProactiveTaskRun {
  id: string
  /** 运行来源。Monitor 与 Schedule 统一写入同一运行事实源。 */
  sourceType: 'schedule' | 'monitor' | 'routine' | 'manual'
  sourceId: string
  /** 实际执行会话 ID；newSession 模式下为运行时新建的会话 */
  sessionId?: string
  status: ProactiveRunStatus
  trigger: 'scheduled' | 'event' | 'manual' | 'recovery'
  startedAt?: number
  endedAt?: number
  outputSummary?: string
  error?: string
}

// ===== Monitor =====

export type MonitorTriggerType = 'file' | 'session' | 'webhook' | 'github' | 'command'

export type MonitorTrigger =
  | { type: 'file'; path: string; events: ('create' | 'modify' | 'delete')[] }
  | { type: 'session'; condition: 'stale'; maxIdleMs: number }
  | { type: 'webhook'; endpoint: string; secret?: string }
  | { type: 'github'; repo: string; events: string[] }
  | { type: 'command'; command: string; intervalMs: number }

export interface ProactiveMonitor {
  id: string
  title: string
  routineId: string
  /** 可选的 Routine 实例绑定；事件触发时执行该实例而非普通 prompt。 */
  routineInstanceId?: string
  /**
   * Monitor 触发后使用的明确执行目标。
   *
   * 不从当前前台会话或全局默认渠道推断，避免无用户确认的事件在
   * 意外上下文中运行。newSession=true 时，sessionId 可以为空。
   */
  execution: ProactiveExecutionTarget
  trigger: MonitorTrigger
  enabled: boolean
  debounceMs: number
  lastEventAt?: number
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

/** Schedule 与 Monitor 复用的受控 Agent 执行目标。 */
export interface ProactiveExecutionTarget {
  sessionId?: string
  workspaceId?: string
  channelId: string
  modelId?: string
  runtime: Extract<AgentRuntime, 'proma' | 'ai-sdk'>
  prompt: string
  newSession?: boolean
  permissionMode?: Extract<PromaPermissionMode, 'safe' | 'plan'>
}

// ===== Recommendation =====

export type RecommendationKind = 'schedule' | 'monitor' | 'memory' | 'skill' | 'follow_up'
export type RecommendationSafetyLevel = 'read_only' | 'writes_memory' | 'writes_files' | 'runs_commands'
export type RecommendationStatus = 'suggested' | 'accepted' | 'dismissed'

export interface ProactiveRecommendation {
  id: string
  kind: RecommendationKind
  title: string
  reason: string
  scope: string
  confidence: number
  safetyLevel: RecommendationSafetyLevel
  duplicateKey: string
  evidence: Array<{
    label: string
    detail: string
    sourceId?: string
    sourceKind?: 'run' | 'memory' | 'approval' | 'schedule' | 'monitor'
  }>
  action: unknown
  status: RecommendationStatus
  createdAt: number
  updatedAt: number
}

// ===== Approval =====

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'edited'
export type ApprovalSourceType = 'memory' | 'skill' | 'file' | 'command' | 'schedule' | 'monitor'
export type ApprovalExecutionStatus = 'pending' | 'succeeded' | 'failed'

export interface ProactiveApproval {
  id: string
  runId?: string
  sourceType: ApprovalSourceType
  title: string
  summary: string
  proposedChange: unknown
  status: ApprovalStatus
  createdAt: number
  resolvedAt?: number
  /** 人工决策后的执行结果；批准不等同于变更已经生效。 */
  executionStatus?: ApprovalExecutionStatus
  executionError?: string
  executedAt?: number
}
