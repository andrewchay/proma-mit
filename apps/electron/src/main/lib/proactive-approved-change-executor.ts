import type { CreateProactiveScheduleInput, ProactiveApproval } from '@gravitas/shared'
import { createMonitor } from './monitor-service'
import { createMemoryItem } from './memory-plugin-service'
import { createApprovedWorkspaceSkill } from './agent-workspace-manager'
import type { CreateMonitorInput } from './monitor-service'
import type { MemoryItemKind } from './memory-plugin-service'

export interface ApprovedChangeExecutorDependencies {
  createSchedule: (input: CreateProactiveScheduleInput) => void
}

/**
 * 执行用户已确认的主动变更。
 *
 * 该入口只认识结构化的审批 payload；涉及文件的 Skill 创建被限制在显式工作区的
 * skills/ 目录中，其他未知类型一律失败并由 ApprovalService 记录执行错误。
 */
export async function executeApprovedChange(
  approval: ProactiveApproval,
  dependencies: ApprovedChangeExecutorDependencies,
): Promise<void> {
  const change = approval.proposedChange
  if (!isRecord(change) || typeof change.type !== 'string') throw new Error('审批变更格式无效')

  switch (change.type) {
    case 'memory_write': {
      if (!isString(change.title) || !isString(change.content)) throw new Error('记忆审批缺少标题或内容')
      createMemoryItem({
        title: change.title,
        content: change.content,
        kind: normalizeMemoryKind(change.kind),
        tags: stringArray(change.tags),
        confidence: typeof change.confidence === 'number' && change.confidence >= 0 && change.confidence <= 1 ? change.confidence : 0.8,
        sourceRunId: approval.runId ?? null,
        sourceSessionId: isNullableString(change.sourceSessionId) ? change.sourceSessionId : null,
      })
      return
    }
    case 'schedule_create': {
      if (!isRecord(change.input)) throw new Error('定时任务审批缺少创建参数')
      dependencies.createSchedule(change.input as unknown as CreateProactiveScheduleInput)
      return
    }
    case 'monitor_create': {
      if (!isRecord(change.input)) throw new Error('监听任务审批缺少创建参数')
      createMonitor(change.input as unknown as CreateMonitorInput)
      return
    }
    case 'skill_create': {
      if (!isString(change.workspaceId) || !isString(change.name) || !isString(change.content)) {
        throw new Error('Skill 审批缺少目标工作区、名称或内容')
      }
      createApprovedWorkspaceSkill(change.workspaceId, change.name, change.content)
      return
    }
    default:
      throw new Error(`审批变更类型暂不支持执行: ${change.type}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeMemoryKind(value: unknown): MemoryItemKind {
  const kinds: MemoryItemKind[] = ['preference', 'correction', 'sop', 'diary', 'fact', 'unknown']
  return typeof value === 'string' && kinds.includes(value as MemoryItemKind) ? value as MemoryItemKind : 'unknown'
}
