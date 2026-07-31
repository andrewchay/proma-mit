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
  sessionId: string
  workspaceId?: string
  channelId: string
  modelId?: string
  runtime: Extract<AgentRuntime, 'proma' | 'ai-sdk'>
  prompt: string
  schedule: ProactiveScheduleSpec
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
  sessionId: string
  workspaceId?: string
  channelId: string
  modelId?: string
  runtime: Extract<AgentRuntime, 'proma' | 'ai-sdk'>
  prompt: string
  schedule: ProactiveScheduleSpec
  permissionMode?: Extract<PromaPermissionMode, 'safe' | 'plan'>
}

export interface ProactiveTaskRun {
  id: string
  sourceType: 'schedule' | 'manual'
  sourceId: string
  sessionId: string
  status: ProactiveRunStatus
  trigger: 'scheduled' | 'manual' | 'recovery'
  startedAt?: number
  endedAt?: number
  outputSummary?: string
  error?: string
}
