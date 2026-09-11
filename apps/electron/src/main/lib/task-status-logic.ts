/**
 * 任务状态纯逻辑 — Task Status Logic
 *
 * 状态语义组（借鉴 Plane StateGroup）：完成判断、WIP、燃尽等跨状态逻辑只认组，
 * 不认具体状态 id；具体状态是每项目的数据行（task_statuses 表，可自定义）。
 * 预置五态沿用旧字符串作 id，保证 tasks.status 历史数据零迁移。
 */

import type { TaskStateGroup, TaskStatusDef } from './project-types'

/** 全部语义组（稳定语义面：跨状态逻辑只允许依赖这六个） */
export const TASK_STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled', 'triage'] as const

/** 预置状态 id（历史版本字面量，永远存在且不可删除） */
export type BuiltinTaskStatusId = 'draft' | 'pending' | 'in_progress' | 'paused' | 'completed'

export const BUILTIN_TASK_STATUS_IDS: BuiltinTaskStatusId[] = ['draft', 'pending', 'in_progress', 'paused', 'completed']

/** 预置状态的组归属（建库种子与未知状态兜底共用） */
export const BUILTIN_STATUS_GROUPS: Record<BuiltinTaskStatusId, TaskStateGroup> = {
  draft: 'backlog',
  pending: 'unstarted',
  in_progress: 'started',
  paused: 'started',
  completed: 'completed',
}

/** 草稿是流程外的待确认态（文档提取/AI 生成产物），始终按字面 id 识别 */
export function isDraftStatusId(statusId: string): boolean {
  return statusId === 'draft'
}

/** 解析状态 id 的语义组：先查项目状态定义，再查预置表，未知 id 兜底为 unstarted */
export function resolveStateGroup(
  statusId: string,
  statuses: Array<Pick<TaskStatusDef, 'id' | 'stateGroup'>>,
): TaskStateGroup {
  const hit = statuses.find((status) => status.id === statusId)
  if (hit) return hit.stateGroup
  if (statusId in BUILTIN_STATUS_GROUPS) return BUILTIN_STATUS_GROUPS[statusId as BuiltinTaskStatusId]
  return 'unstarted'
}

/** 是否处于 completed 语义组（完成判断的唯一入口） */
export function isCompletedStatus(
  statusId: string,
  statuses: Array<Pick<TaskStatusDef, 'id' | 'stateGroup'>>,
): boolean {
  return resolveStateGroup(statusId, statuses) === 'completed'
}

/** 默认初始状态：项目状态定义中 isDefault 的那条，兜底 'pending' */
export function resolveDefaultActiveStatus(statuses: Array<Pick<TaskStatusDef, 'id' | 'stateGroup' | 'isDefault'>>): string {
  return statuses.find((status) => status.isDefault)?.id ?? 'pending'
}

export interface BuiltinStatusSeed {
  id: BuiltinTaskStatusId
  name: string
  stateGroup: TaskStateGroup
  position: number
  isDefault: boolean
}

/** 每项目预置状态种子（迁移补种与新建项目共用；position 即看板列序） */
export function builtinTaskStatusSeed(): BuiltinStatusSeed[] {
  return [
    { id: 'draft', name: '草稿', stateGroup: 'backlog', position: 0, isDefault: false },
    { id: 'pending', name: '待处理', stateGroup: 'unstarted', position: 1, isDefault: true },
    { id: 'in_progress', name: '进行中', stateGroup: 'started', position: 2, isDefault: false },
    { id: 'paused', name: '已暂停', stateGroup: 'started', position: 3, isDefault: false },
    { id: 'completed', name: '已完成', stateGroup: 'completed', position: 4, isDefault: false },
  ]
}
