import { createHash } from 'node:crypto'
import type { ApplyTaskArrangementSuggestionInput, Project, Task, TaskArrangementSuggestion, TaskAssignee, TaskDependency, TaskStatusDef } from './project-types'
import * as store from './project-sqlite-store'
import { isCompletedStatus } from './task-status-logic'

const DAY_MS = 24 * 60 * 60 * 1000
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function suggestionForProject(project: Project, tasks: Task[], statuses: TaskStatusDef[], dependencies: TaskDependency[]): TaskArrangementSuggestion[] {
  const statusById = new Map(statuses.map((status) => [status.id, status]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const blockersByTask = new Map<string, string[]>()
  for (const blocker of store.listTaskBlockers(project.id)) {
    const entries = blockersByTask.get(blocker.taskId) ?? []
    entries.push(blocker.reason)
    blockersByTask.set(blocker.taskId, entries)
  }
  const openTasks = tasks.filter((task) => !isCompletedStatus(task.status, statuses))
  const workload = new Map<string, { assignee: TaskAssignee; memberId?: string; count: number }>()
  for (const task of openTasks) {
    if (!task.assignee || task.assignee.userId.startsWith('agent-')) continue
    const current = workload.get(task.assignee.userId)
    workload.set(task.assignee.userId, { assignee: task.assignee, ...(task.assigneeMemberId ? { memberId: task.assigneeMemberId } : {}), count: (current?.count ?? 0) + 1 })
  }
  const candidates = [...workload.values()].sort((left, right) => left.count - right.count || left.assignee.displayName.localeCompare(right.assignee.displayName))
  const suggestions: TaskArrangementSuggestion[] = []

  for (const task of openTasks) {
    const edges = dependencies.filter((edge) => edge.taskId === task.id)
    const blockers = blockersByTask.get(task.id) ?? []
    const reviewReasons: string[] = []
    if (blockers.length > 0) reviewReasons.push('扫描到未完成的前置依赖；请核实阻塞关系和解除条件。')
    let suggestedAssignee: TaskAssignee | undefined
    let suggestedAssigneeMemberId: string | undefined
    let assigneeReason: string | undefined
    if (!task.assignee) {
      const candidate = candidates.find((entry) => entry.assignee.userId !== task.assignee?.userId)
      if (candidate) {
        suggestedAssignee = candidate.assignee
        suggestedAssigneeMemberId = candidate.memberId
        assigneeReason = `该负责人当前在本项目有 ${candidate.count} 项未完成任务，为已知成员中负载最低者；技能与可用时间未核验，需你确认。`
        reviewReasons.push('负责人候选仅按本项目未完成任务数估算，需核验技能和可用时间。')
      } else {
        reviewReasons.push('项目内没有可参考的已分配负责人，需你补充候选人。')
      }
    }

    let suggestedDueDate: number | undefined
    let dueDateReason: string | undefined
    if (task.dueDate === undefined) {
      const prerequisiteTasks = edges.map((edge) => taskById.get(edge.dependsOnTaskId)).filter((item): item is Task => Boolean(item))
      const prerequisiteDates = prerequisiteTasks.map((item) => item.dueDate)
      if (edges.length > 0 && prerequisiteTasks.length === edges.length && prerequisiteDates.length > 0 && prerequisiteDates.every((date): date is number => date !== undefined)) {
        suggestedDueDate = Math.max(...prerequisiteDates) + DAY_MS
        dueDateReason = '依据前置任务截止日期后移一天估算；未包含工时、节假日和负责人日程，需你确认。'
        reviewReasons.push('建议日期只按前置任务日期推算，未评估工时和日历。')
      } else {
        reviewReasons.push(edges.length > 0 ? '前置任务缺少有效截止日期或依赖记录，无法可靠推算本任务日期。' : '没有依赖日期或工时信息，无法可靠推算截止日期。')
      }
    }
    if (task.dueDate !== undefined && task.dueDate < Date.now()) reviewReasons.push('任务已逾期；请确认剩余工作和新的可行日期。')

    let suggestedStatus: TaskArrangementSuggestion['suggestedStatus']
    let statusReason: string | undefined
    if (blockers.length > 0 && statusById.get(task.status)?.stateGroup === 'started') {
      const pausedStatus = statuses.find((status) => status.id === 'paused')
      if (pausedStatus && task.status !== pausedStatus.id) {
        suggestedStatus = { id: pausedStatus.id, name: pausedStatus.name }
        statusReason = `存在 ${blockers.length} 项未完成前置依赖，建议暂时设为「${pausedStatus.name}」，解除阻塞后再恢复。`
      } else {
        reviewReasons.push('任务存在阻塞，但项目没有可用的暂停状态；请人工核对。')
      }
    }

    const updates = {
      assignee: suggestedAssignee,
      assigneeMemberId: suggestedAssigneeMemberId,
      dueDate: suggestedDueDate,
      status: suggestedStatus?.id,
    }
    const id = fingerprint({ projectId: project.id, projectArchivedAt: project.archivedAt ?? null, taskId: task.id, taskUpdatedAt: task.updatedAt, taskStatus: task.status, priority: task.priority, dependencies: edges, blockers, updates })
    suggestions.push({
      id,
      projectId: project.id,
      projectTitle: project.title,
      ...(project.archivedAt ? { projectArchivedAt: project.archivedAt } : {}),
      taskId: task.id,
      taskTitle: task.title,
      taskUpdatedAt: task.updatedAt,
      taskStatus: task.status,
      taskStatusName: statusById.get(task.status)?.name ?? task.status,
      ...(task.assignee ? { currentAssignee: task.assignee } : {}),
      ...(task.dueDate !== undefined ? { currentDueDate: task.dueDate } : {}),
      priority: task.priority,
      dependencies: edges.map((edge) => taskById.get(edge.dependsOnTaskId)?.title ?? '依赖任务已不存在'),
      blockers,
      ...(suggestedAssignee ? { suggestedAssignee, ...(suggestedAssigneeMemberId ? { suggestedAssigneeMemberId } : {}), assigneeReason } : {}),
      ...(suggestedDueDate !== undefined ? { suggestedDueDate, dueDateReason } : {}),
      ...(suggestedStatus ? { suggestedStatus, statusReason } : {}),
      reviewReasons,
    })
  }
  return suggestions
}

/** 只读扫描全部项目（含归档）；不创建规划Run、不调用模型、不派发员工。 */
export function listTaskArrangementSuggestions(): TaskArrangementSuggestion[] {
  return store.listProjects()
    .flatMap((project) => suggestionForProject(project, store.listTasks(project.id, { includeSubTasks: true, includeDrafts: true }), store.listTaskStatuses(project.id), store.listTaskDependencies(project.id)))
    .sort((left, right) => {
      const now = Date.now()
      const rank = (item: TaskArrangementSuggestion): number => item.blockers.length > 0 ? 0
        : item.currentDueDate !== undefined && item.currentDueDate < now ? 1
        : item.priority === 'critical' ? 2
        : item.priority === 'high' ? 3
        : !item.currentAssignee ? 4 : 5
      return rank(left) - rank(right) || (left.currentDueDate ?? Number.MAX_SAFE_INTEGER) - (right.currentDueDate ?? Number.MAX_SAFE_INTEGER) || left.projectTitle.localeCompare(right.projectTitle) || left.taskTitle.localeCompare(right.taskTitle)
    })
}

function parseApplyInput(raw: unknown): ApplyTaskArrangementSuggestionInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('待办建议确认内容无效')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => !['suggestionId', 'taskId', 'expectedUpdatedAt', 'changes'].includes(key))
    || typeof value.suggestionId !== 'string' || !/^[a-f0-9]{64}$/.test(value.suggestionId)
    || typeof value.taskId !== 'string' || !value.taskId.trim()
    || !Number.isSafeInteger(value.expectedUpdatedAt) || Number(value.expectedUpdatedAt) < 1
    || !value.changes || typeof value.changes !== 'object' || Array.isArray(value.changes) || Object.getPrototypeOf(value.changes) !== Object.prototype) throw new Error('待办建议身份或任务版本无效')
  const changes = value.changes as Record<string, unknown>
  if (Object.keys(changes).length === 0 || Object.keys(changes).some((key) => !['assignee', 'assigneeMemberId', 'dueDate', 'status'].includes(key))) throw new Error('待办建议只能修改负责人、截止日期或状态')
  if (changes.assignee !== undefined && (!changes.assignee || typeof changes.assignee !== 'object' || Array.isArray(changes.assignee)
    || Object.getPrototypeOf(changes.assignee) !== Object.prototype
    || Object.keys(changes.assignee as Record<string, unknown>).some((key) => !['userId', 'displayName'].includes(key))
    || typeof (changes.assignee as Record<string, unknown>).userId !== 'string' || typeof (changes.assignee as Record<string, unknown>).displayName !== 'string')) throw new Error('建议负责人信息无效')
  if (changes.assigneeMemberId !== undefined && typeof changes.assigneeMemberId !== 'string') throw new Error('建议负责人目录身份无效')
  if (changes.dueDate !== undefined && (!Number.isSafeInteger(changes.dueDate) || Number(changes.dueDate) <= 0)) throw new Error('建议截止日期无效')
  if (changes.status !== undefined && (typeof changes.status !== 'string' || !changes.status.trim())) throw new Error('建议任务状态无效')
  return value as unknown as ApplyTaskArrangementSuggestionInput
}

/** 用户确认后应用仍然有效的建议；版本冲突拒绝写入，且不触发任何自动派发监听器。 */
export function applyTaskArrangementSuggestion(raw: unknown): Task {
  const input = parseApplyInput(raw)
  const currentSuggestion = listTaskArrangementSuggestions().find((item) => item.id === input.suggestionId && item.taskId === input.taskId)
  if (!currentSuggestion || currentSuggestion.taskUpdatedAt !== input.expectedUpdatedAt) throw new Error('任务已变化，旧建议不能应用；请重新扫描核对。')
  const updates: Partial<Omit<Task, 'id' | 'projectId' | 'createdAt'>> = {}
  if (input.changes.assignee) {
    if (!currentSuggestion.suggestedAssignee || JSON.stringify(input.changes.assignee) !== JSON.stringify(currentSuggestion.suggestedAssignee)) throw new Error('负责人建议已变化，请重新扫描')
    updates.assignee = input.changes.assignee
  }
  if (input.changes.assigneeMemberId !== undefined) {
    if (!updates.assignee || currentSuggestion.suggestedAssigneeMemberId !== input.changes.assigneeMemberId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.changes.assigneeMemberId)) throw new Error('负责人目录身份与建议不匹配')
    updates.assigneeMemberId = input.changes.assigneeMemberId
  }
  if (input.changes.dueDate !== undefined) {
    if (currentSuggestion.suggestedDueDate !== input.changes.dueDate) throw new Error('截止日期建议已变化，请重新扫描')
    updates.dueDate = input.changes.dueDate
  }
  if (input.changes.status !== undefined) {
    if (currentSuggestion.suggestedStatus?.id !== input.changes.status) throw new Error('状态建议已变化，请重新扫描')
    updates.status = input.changes.status
  }
  const database = store.getProjectDb()
  let updated: Task | null = null
  database.transaction(() => {
    const before = store.getTask(input.taskId)
    if (!before || before.projectId !== currentSuggestion.projectId || before.updatedAt !== input.expectedUpdatedAt) throw new Error('任务已变化，旧建议不能应用；请重新扫描核对。')
    updated = store.updateTaskWithoutOwnerScheduleWake(input.taskId, updates)
    if (!updated) throw new Error('任务已不存在')
    store.recordProjectActivity({
      projectId: before.projectId,
      entityType: 'task',
      entityId: before.id,
      action: 'owner_arrangement_applied',
      summary: `用户确认应用待办安排建议「${before.title}」`,
      actor: 'local-user',
      payload: {
        suggestionId: input.suggestionId,
        before: { assignee: before.assignee, dueDate: before.dueDate, status: before.status },
        after: { assignee: updated.assignee, dueDate: updated.dueDate, status: updated.status },
      },
    })
  })()
  if (!updated) throw new Error('待办建议没有写入任务')
  return updated
}
