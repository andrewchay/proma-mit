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
  schedule: ProactiveScheduleSpec
  /** 新建会话执行：每次运行时创建新 Agent 会话（默认 false） */
  newSession?: boolean
  permissionMode?: Extract<PromaPermissionMode, 'safe' | 'plan'>
}

export interface ProactiveTaskRun {
  id: string
  sourceType: 'schedule' | 'manual'
  sourceId: string
  /** 实际执行会话 ID；newSession 模式下为运行时新建的会话 */
  sessionId?: string
  status: ProactiveRunStatus
  trigger: 'scheduled' | 'manual' | 'recovery'
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
  trigger: MonitorTrigger
  enabled: boolean
  debounceMs: number
  lastEventAt?: number
  lastRunAt?: number
  createdAt: number
  updatedAt: number
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
}
