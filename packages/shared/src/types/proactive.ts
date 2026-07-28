/** Proactive Scheduler 的持久化契约。第一阶段仅支持一次性和固定间隔任务。 */

import type { AgentRuntime, PromaPermissionMode } from './agent'

export type ProactiveScheduleSpec =
  | { type: 'at'; runAt: number }
  | { type: 'interval'; intervalMs: number }

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
