/**
 * 任务状态语义桥接 — Task Status Store Bridge
 *
 * 给同步层（auto-sync / polling 等非 IPC 模块）提供"按项目取状态定义 + 判断语义组"
 * 的统一入口，避免它们各自依赖 project-service（引发循环引用）或直连 store。
 */

import { listTaskStatuses as storeListTaskStatuses } from './project-sqlite-store'
import { isCompletedStatus, resolveStateGroup } from './task-status-logic'
import type { TaskStatusDef, TaskStateGroup } from './project-types'

/** 按项目取状态定义（同步层用；读操作直连 store，无副作用） */
export function listTaskStatuses(projectId: string): TaskStatusDef[] {
  return storeListTaskStatuses(projectId)
}

/** 判断任务状态是否处于 completed 语义组（完成语义唯一入口） */
export function isCompletedStatusId(statusId: string, projectId: string): boolean {
  return isCompletedStatus(statusId, storeListTaskStatuses(projectId))
}

/** 解析任务状态所属语义组（未知 id 兜底预置表） */
export function resolveTaskStateGroup(statusId: string, projectId: string): TaskStateGroup {
  return resolveStateGroup(statusId, storeListTaskStatuses(projectId))
}
