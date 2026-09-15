/**
 * 项目任务 → 日程视图映射（schedule-task-mapping）
 *
 * listAllProjectTasksLite 的轻量结构 → ScheduleTask 形状，供月历/日详情合流渲染。
 * 纯展示适配：TaskBoard 四列看板不消费项目任务（状态流语义不同）。
 */
import type { ScheduleTask } from '@/atoms/paa-atoms'

/** 轻量项目任务结构（与主进程 project-service.ts 的 ProjectTaskLite 对齐） */
export interface ProjectTaskLite {
  id: string
  projectId: string
  projectTitle: string
  title: string
  status: string
  stateGroup: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  dueDate: number
}

/** 语义组 → 日程任务状态（started→in-progress，其余→todo；完成组已被主进程过滤） */
export function projectStateGroupToScheduleStatus(stateGroup: string): ScheduleTask['status'] {
  return stateGroup === 'started' ? 'in-progress' : 'todo'
}

/** 时间戳 → 本地 YYYY-MM-DD（手工 padStart 拼，勿用 toLocaleDateString——zh-CN 输出斜杠） */
export function timestampToDueDate(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 优先级映射：项目 critical → 日程 urgent，其余同名直过 */
export function projectPriorityToSchedulePriority(priority: ProjectTaskLite['priority']): ScheduleTask['priority'] {
  return priority === 'critical' ? 'urgent' : priority
}

/** 轻量项目任务 → ScheduleTask 形状（id 加 project- 前缀防冲突；category 带项目名供徽标展示） */
export function projectTaskToScheduleTask(task: ProjectTaskLite): ScheduleTask {
  return {
    id: `project-${task.id}`,
    title: task.title,
    status: projectStateGroupToScheduleStatus(task.stateGroup),
    priority: projectPriorityToSchedulePriority(task.priority),
    dueDate: timestampToDueDate(task.dueDate),
    category: `project:${task.projectTitle}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
