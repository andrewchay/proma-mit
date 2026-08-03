/** 项目风险告警：把逾期、阻塞与高风险工作项统一为可在界面主动消费的提醒。 */

import { listProjectWorkItems, listTaskBlockers, listTasks } from './project-service.ts'
import type { ProjectAlert } from './project-types.ts'

export async function listProjectAlerts(projectId: string, now = Date.now()): Promise<ProjectAlert[]> {
  const [workItems, blockers, tasks] = await Promise.all([
    listProjectWorkItems(projectId),
    listTaskBlockers(projectId),
    listTasks(projectId, { includeSubTasks: true, includeDrafts: true }),
  ])
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const alerts: ProjectAlert[] = []
  for (const item of workItems) {
    if (item.status !== 'completed' && item.dueDate !== undefined && item.dueDate < now) {
      alerts.push({
        id: `overdue:${item.entityType}:${item.id}`,
        projectId,
        type: 'overdue',
        severity: item.entityType === 'task' && taskById.get(item.id)?.priority === 'critical' ? 'critical' : 'warning',
        entityType: item.entityType,
        entityId: item.id,
        title: `已逾期：${item.title}`,
        description: `截止于 ${new Date(item.dueDate).toLocaleDateString('zh-CN')}，请${item.assignee ? `提醒负责人 ${item.assignee.displayName}` : '尽快指派负责人'}。`,
        assignee: item.assignee,
        createdAt: now,
      })
    }
  }
  for (const blocker of blockers) {
    const task = taskById.get(blocker.taskId)
    if (!task) continue
    alerts.push({
      id: `blocked:${blocker.taskId}:${blocker.dependsOnTaskId}`,
      projectId,
      type: 'blocked',
      severity: task.priority === 'critical' ? 'critical' : 'warning',
      entityType: 'task',
      entityId: task.id,
      title: `被阻塞：${task.title}`,
      description: `${blocker.reason}${task.assignee ? `；负责人：${task.assignee.displayName}` : '；尚未指派负责人'}。`,
      assignee: task.assignee,
      createdAt: now,
    })
  }
  for (const task of tasks) {
    if (task.status === 'completed' || (task.riskLevel !== 'high' && task.riskLevel !== 'critical')) continue
    alerts.push({
      id: `risk:${task.id}`,
      projectId,
      type: 'high_risk',
      severity: task.riskLevel === 'critical' ? 'critical' : 'warning',
      entityType: 'task',
      entityId: task.id,
      title: `${task.riskLevel === 'critical' ? '关键' : '高'}风险：${task.title}`,
      description: `风险等级为 ${task.riskLevel}${task.assignee ? `；负责人：${task.assignee.displayName}` : '；请先指派负责人'}。`,
      assignee: task.assignee,
      createdAt: now,
    })
  }
  return alerts.sort((left, right) => (left.severity === 'critical' ? -1 : 1) - (right.severity === 'critical' ? -1 : 1))
}
