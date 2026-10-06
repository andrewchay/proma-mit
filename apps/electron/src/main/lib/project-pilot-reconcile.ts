import { createHash } from 'node:crypto'
import type { PilotAttention, PilotObservation, PilotTaskObservation } from '@gravitas/shared'
import { getProject, listTasks, listTaskBlockers } from './project-service'
import { getProjectChain } from './project-chain-service'
import { getProjectDb, listAgentExecutionsByProject } from './project-sqlite-store'
import { listTaskStatuses } from './task-status-store-bridge'
import { resolveStateGroup } from './task-status-logic'
import { parsePilotHumanRequest } from './project-pilot-approval'

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
    let rootTaskId = task.id
    let parentId = task.parentId
    const visited = new Set([task.id])
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId)
      rootTaskId = parentId
      parentId = taskById.get(parentId)?.parentId
    }
    const blocked = blockerByTask.get(task.id) ?? []
    const latest = latestExecutionByTask.get(task.id)
    const group = resolveStateGroup(task.status, statuses)
    // A04 主动询问：负责人 Pilot 执行已完成、说明带【需要人工】且未答复 → 待人工答复事实（不进评审环路）。
    const humanRequest = task.status === 'paused' && latest?.status === 'completed'
      && latest.pilotCommandId && latest.resultSummary === task.completionNotes
      ? parsePilotHumanRequest(task.completionNotes) : null
    let state: PilotTaskObservation['state'] = 'needs_attention'
    let reason = '需要确认下一步'
    if (group === 'completed') { state = 'done'; reason = '任务已完成' }
    else if (group === 'cancelled' || task.status === 'draft' || group === 'backlog') {
      state = 'inactive'
      reason = group === 'cancelled' ? '任务已取消' : task.status === 'draft' ? '草稿等待确认' : '尚未进入执行流程'
    } else if (submittedTaskIds.has(task.id)) {
      state = 'awaiting_review'; reason = '交付已提交，等待人工审阅'
    } else if (humanRequest) {
      state = 'needs_attention'; reason = `待人工答复（${humanRequest.category}）：${humanRequest.detail}`
    } else if (task.status === 'paused' && latest?.status === 'completed') {
      reason = '执行已完成，待核对交付版本'
    } else if (task.status === 'paused') {
      reason = latest?.status === 'failed' ? '执行失败，等待人工处理' : '任务已暂停'
    } else if (blocked.length > 0) {
      state = 'waiting_dependency'; reason = blocked.map((item) => item.reason).join('；')
    } else if (latest?.status === 'queued' || latest?.status === 'running') {
      state = 'running'; reason = latest.status === 'queued' ? '执行排队中' : '员工执行中'
    } else if (latest?.status === 'completed') {
      // 批准仅适用于同一轮已结算的 Pilot 执行；依赖、状态、负责人仍须重新满足。
      const approval = getProjectDb().prepare(`SELECT 1 FROM pilot_approval_resolutions AS resolution
        JOIN pilot_commands AS command ON command.execution_id = resolution.execution_id
        WHERE resolution.task_id = ? AND resolution.execution_id = ? AND resolution.decision = 'approved'
          AND command.source_task_id = resolution.task_id AND command.role = 'executor'
          AND resolution.grant_id = command.grant_id AND command.state = 'settled'
          AND resolution.resolved_version = ? AND resolution.resolved_notes = ? LIMIT 1`)
        .get(task.id, latest.id, task.updatedAt, task.completionNotes ?? null)
      if (group === 'unstarted' && blocked.length === 0 && task.assignee && approval) {
        state = 'ready'; reason = '人工批准续跑；已指定负责人，待核实执行前置条件'
      } else {
        reason = '存在历史执行，需核实当前交付'
      }
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
      taskId: task.id, parentTaskId: task.parentId, rootTaskId,
      title: task.title, status: task.status, updatedAt: task.updatedAt,
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
    // A04：待人工答复的 Pilot 询问；sourceVersion 用任务 updatedAt，答复后事实变化即失效。
    ...tasks.flatMap((task) => {
      const latest = latestExecutionByTask.get(task.id)
      const request = task.status === 'paused' && latest?.status === 'completed'
        && latest.pilotCommandId && latest.resultSummary === task.completionNotes
        ? parsePilotHumanRequest(task.completionNotes) : null
      if (!request) return []
      return [{
        sourceType: 'approval' as const, sourceId: task.id, taskId: task.id, sourceVersion: task.updatedAt,
        reason: `待人工答复（${request.category}）：${request.detail}`,
      }]
    }),
  ]
  // 指纹仅标识本次事实投影，不作为 SQLite 快照/命令乐观锁；写命令须重新读取权威事实。
  const fingerprint = createHash('sha256').update(JSON.stringify({
    projectId, projectUpdatedAt: project.updatedAt, chainRevision: chain.revision,
    tasks: observations, attention,
  })).digest('hex')
  return { projectId, projectTitle: project.title, chainRevision: chain.revision,
    fingerprint, observedAt: Date.now(), tasks: observations, attention, mode: 'read_only' }
}
