/**
 * 项目管理 Jotai 状态层 — Project Atoms
 *
 * 看板拖拽的状态真源：任务表（按 projectId 隔离）+ 看板列派生 atom。
 * 拖拽落点 → 乐观更新 atom → IPC reorderTask → 失败回滚。
 * 与全仓 Jotai 惯例对齐（此前看板数据是 ProjectView 局部 useState）。
 */

import { atom } from 'jotai'

/** 渲染层任务结构（与主进程 Task 对齐的最小字段集；preload 返回 unknown 需就地收窄） */
export interface ProjectTaskAtom {
  id: string
  projectId: string
  parentId?: string
  title: string
  description: string
  status: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  assignee?: { userId: string; displayName: string }
  completedAt?: number
  dueDate?: number
  sortOrder: number
  createdAt: number
  updatedAt: number
}

/** 项目任务状态定义（task_statuses 表行） */
export interface ProjectTaskStatusAtom {
  id: string
  projectId: string
  name: string
  stateGroup: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' | 'triage'
  position: number
  color?: string
  wipLimit?: number
  isBuiltin: boolean
  isDefault: boolean
  createdAt: number
}

/** 任务表：按 projectId 隔离的 Map */
export const projectTasksAtom = atom<Map<string, ProjectTaskAtom[]>>(new Map())

/** 状态定义表：按 projectId 隔离 */
export const projectTaskStatusesAtom = atom<Map<string, ProjectTaskStatusAtom[]>>(new Map())

/** 当前看板所在项目 ID（null = 看板未挂载） */
export const activeKanbanProjectIdAtom = atom<string | null>(null)

/** 拖拽进行中的任务 ID（用于视觉反馈） */
export const draggingTaskIdAtom = atom<string | null>(null)

/**
 * 外部轮询状态变化信号（全局监听写入；ProjectDetail 按订阅 projectId 过滤消费）。
 * 仅存最新一次变化——消费方以变化时刻触发刷新，不消费历史。
 */
export const pollStatusChangedAtom = atom<{ projectId: string; taskId: string; newStatus: string | null; at: number } | null>(null)

// ===== 派生 atom：看板列 =====

/** 列定义 + 各列内按 sortOrder 升序的任务（一个状态一列，含空列） */
export const kanbanColumnsAtom = atom<Array<{ status: ProjectTaskStatusAtom; tasks: ProjectTaskAtom[] }>>((get) => {
  const projectId = get(activeKanbanProjectIdAtom)
  if (!projectId) return []
  const statuses = get(projectTaskStatusesAtom).get(projectId) ?? []
  const tasks = get(projectTasksAtom).get(projectId) ?? []
  const byStatus = new Map<string, ProjectTaskAtom[]>()
  for (const task of tasks) {
    const list = byStatus.get(task.status) ?? []
    list.push(task)
    byStatus.set(task.status, list)
  }
  return statuses.map((status) => ({
    status,
    tasks: (byStatus.get(status.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder),
  }))
})

// ===== 写入 atom =====

/** 整体替换某项目的任务列表（loadData 后写入） */
export const setProjectTasksAtom = atom(
  null,
  (get, set, payload: { projectId: string; tasks: ProjectTaskAtom[] }) => {
    const next = new Map(get(projectTasksAtom))
    next.set(payload.projectId, payload.tasks)
    set(projectTasksAtom, next)
  },
)

/** 整体替换某项目的状态定义列表 */
export const setProjectTaskStatusesAtom = atom(
  null,
  (get, set, payload: { projectId: string; statuses: ProjectTaskStatusAtom[] }) => {
    const next = new Map(get(projectTaskStatusesAtom))
    next.set(payload.projectId, payload.statuses)
    set(projectTaskStatusesAtom, next)
  },
)

/**
 * 乐观移动任务：先改本地（状态 + 排序），返回移动前快照供失败回滚。
 */
export const optimisticMoveTaskAtom = atom(
  null,
  (get, set, payload: {
    projectId: string
    taskId: string
    newStatusId: string
    newSortOrder: number
  }): ProjectTaskAtom[] => {
    const tasks = get(projectTasksAtom).get(payload.projectId) ?? []
    const snapshot = [...tasks]
    const next = tasks.map((task) =>
      task.id === payload.taskId
        ? { ...task, status: payload.newStatusId, sortOrder: payload.newSortOrder, updatedAt: Date.now() }
        : task,
    )
    set(projectTasksAtom, new Map(get(projectTasksAtom)).set(payload.projectId, next))
    return snapshot
  },
)

/** 回滚：恢复快照 */
export const rollbackTasksAtom = atom(
  null,
  (get, set, payload: { projectId: string; snapshot: ProjectTaskAtom[] }) => {
    set(projectTasksAtom, new Map(get(projectTasksAtom)).set(payload.projectId, [...payload.snapshot]))
  },
)

/**
 * 用 IPC reorderTask 的返回值直接更新 atom（移动任务 + 重编号波及的任务），
 * 免去整列重拉。与后端 ReorderTaskResult 对齐（preload 返回 unknown 就地收窄）。
 */
export const applyReorderResultAtom = atom(
  null,
  (get, set, payload: { projectId: string; result: { task?: ProjectTaskAtom; rewrittenTasks?: ProjectTaskAtom[] } }) => {
    if (!payload.result?.task) return
    const tasks = get(projectTasksAtom).get(payload.projectId) ?? []
    const patchMap = new Map<string, ProjectTaskAtom>([
      [payload.result.task.id, payload.result.task],
      ...(payload.result.rewrittenTasks ?? []).map((t) => [t.id, t] as const),
    ])
    const next = tasks.map((task) => {
      const patch = patchMap.get(task.id)
      return patch ? { ...task, ...patch } : task
    })
    set(projectTasksAtom, new Map(get(projectTasksAtom)).set(payload.projectId, next))
  },
)
