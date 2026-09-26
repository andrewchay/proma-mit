import { createHash } from 'node:crypto'
import type { PilotAttention, PilotObservation, PilotTaskObservation } from '@gravitas/shared'
import { getProject, listTasks, listTaskBlockers } from './project-service'
import { getProjectChain } from './project-chain-service'
import { listAgentExecutionsByProject } from './project-sqlite-store'
import { listTaskStatuses } from './task-status-store-bridge'
import { resolveStateGroup } from './task-status-logic'

/** Pilot 的只读事实投影。没有授权/预算/命令契约前，不从此服务派发或调用模型。 */

export async function observeProjectPilot(projectId: string): Promise<PilotObservation> {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目 ID')
  const project = await getProject(projectId)
  if (!project) throw new Error('项目不存在')
  const [tasks, blockers, statuses] = await Promise.all([
    listTasks(projectId, { includeSubTasks: true, includeDrafts: true }),
    listTaskBlockers(projectId),
    listTaskStatuses(projectId),
  ])
  const chain = getProjectChain(projectId)
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const blockerByTask = new Map<string, typeof blockers>()
  for (const blocker of blockers) {
    blockerByTask.set(blocker.taskId, [...(blockerByTask.get(blocker.taskId) ?? []), blocker])
  }
  const submittedTaskIds = new Set(chain.drafts.filter((delivery) => delivery.status === 'submitted').map((delivery) => delivery.taskId))
  const latestExecutionByTask = new Map<string, ReturnType<typeof listAgentExecutionsByProject>[number]>()
  for (const execution of listAgentExecutionsByProject(projectId)) {
    if (execution.entityType === 'task' && !latestExecutionByTask.has(execution.entityId)) {
      latestExecutionByTask.set(execution.entityId, execution)
    }
  }
  const observations = tasks.map((task): PilotTaskObservation => {
    const blocked = blockerByTask.get(task.id) ?? []
    const latest = latestExecutionByTask.get(task.id)
    const group = resolveStateGroup(task.status, statuses)
    let state: PilotTaskObservation['state'] = 'needs_attention'
    let reason = '需要确认下一步'
    if (group === 'completed') { state = 'done'; reason = '任务已完成' }
    else if (group === 'cancelled' || task.status === 'draft' || group === 'backlog') {
      state = 'inactive'
      reason = group === 'cancelled' ? '任务已取消' : task.status === 'draft' ? '草稿等待确认' : '尚未进入执行流程'
    } else if (submittedTaskIds.has(task.id)) {
      state = 'awaiting_review'; reason = '交付已提交，等待人工审阅'
    } else if (task.status === 'paused' && latest?.status === 'completed') {
      reason = '执行已完成，待核对交付版本'
    } else if (task.status === 'paused') {
      reason = latest?.status === 'failed' ? '执行失败，等待人工处理' : '任务已暂停'
    } else if (blocked.length > 0) {
      state = 'waiting_dependency'; reason = blocked.map((item) => item.reason).join('；')
    } else if (latest?.status === 'queued' || latest?.status === 'running') {
      state = 'running'; reason = latest.status === 'queued' ? '执行排队中' : '员工执行中'
    } else if (latest?.status === 'completed') {
      // 旧执行不能证明当前任务已经交付；本投影不触发任何派发。
      reason = '存在历史执行，需核实当前交付'
    } else if (latest?.status === 'failed') {
      reason = '执行失败，等待人工处理'
    } else if (group === 'started') {
      state = 'needs_attention'; reason = '任务标记进行中，但没有可确认的进行中执行'
    } else if (group === 'unstarted' && task.assignee) {
      state = 'ready'; reason = '依赖已满足；已指定负责人，待核实执行前置条件'
    } else if (group === 'unstarted') {
      reason = '尚未指定负责人'
    }
    return {
      taskId: task.id, title: task.title, status: task.status, updatedAt: task.updatedAt,
      state, reason, executionId: latest?.id,
      blockerTaskIds: [...new Set(blocked.map((item) => item.dependsOnTaskId))].sort(),
    }
  })
  const attention: PilotAttention[] = [
    ...chain.decisions.filter((decision) => decision.status === 'candidate' && decision.daci?.approverId === 'local-user').map((decision) => ({
      sourceType: 'decision' as const, sourceId: decision.id, sourceVersion: decision.version,
      reason: `待拍板决策：${decision.title}`,
    })),
    ...chain.drafts.filter((delivery) => delivery.status === 'submitted' && delivery.responsibilities?.reviewerId === 'local-user' && taskById.has(delivery.taskId)).map((delivery) => ({
      sourceType: 'delivery' as const, sourceId: delivery.id, sourceVersion: delivery.version,
      taskId: delivery.taskId, reason: `待审阅交付：${delivery.title}`,
    })),
  ]
  // 指纹仅标识本次事实投影，不作为 SQLite 快照/命令乐观锁；写命令须重新读取权威事实。
  const fingerprint = createHash('sha256').update(JSON.stringify({
    projectId, projectUpdatedAt: project.updatedAt, chainRevision: chain.revision,
    tasks: observations, attention,
  })).digest('hex')
  return { projectId, projectTitle: project.title, chainRevision: chain.revision,
    fingerprint, observedAt: Date.now(), tasks: observations, attention, mode: 'read_only' }
}
