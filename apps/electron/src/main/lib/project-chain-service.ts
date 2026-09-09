import type { ProjectChain, ProjectChainCommand } from '@gravitas/shared'
import {
  getAgentExecution,
  getProject,
  getProjectDb,
  getTask,
  listTaskDependencies,
} from './project-sqlite-store'
import { applyChainCommand, emptyProjectChain } from './project-chain'
import { getWorkflowIdentityDirectory } from './workflow-identity-service'

export function getProjectChain(projectId: string): ProjectChain {
  if (typeof projectId !== 'string' || !getProject(projectId)) throw new Error('项目不存在')
  const row = getProjectDb()
    .prepare(
      'SELECT payload FROM project_chain_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 1',
    )
    .get(projectId) as { payload: string } | undefined
  if (!row) return emptyProjectChain()
  const parsed = JSON.parse(row.payload) as Partial<ProjectChain>
  return {
    ...emptyProjectChain(),
    ...parsed,
    projectDefinitionOfDone: parsed.projectDefinitionOfDone ?? [],
    taskDefinitionOfDone: parsed.taskDefinitionOfDone ?? {},
    dependencyHandoffs: parsed.dependencyHandoffs ?? [],
    decisions: (parsed.decisions ?? []).map((decision) => ({
      ...decision,
      status: decision.status ?? 'decided',
      impactTaskIds: decision.impactTaskIds ?? [],
      alternatives: decision.alternatives ?? [],
    })),
    drafts: (parsed.drafts ?? []).map((draft) => ({
      ...draft,
      definitionOfDone: draft.definitionOfDone ?? [],
    })),
  } as ProjectChain
}

/** 在同一事务内校验版本、项目归属并追加快照，拒绝覆盖并发更新。 */
export function updateProjectChain(
  projectId: string,
  expectedRevision: number,
  command: ProjectChainCommand,
): ProjectChain {
  let result: ProjectChain | undefined
  getProjectDb().transaction(() => {
    const current = getProjectChain(projectId)
    if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision)
      throw new Error('链路已更新，请刷新后重试')
    if (!command || typeof command !== 'object') throw new Error('无效的链路操作')
    const enabledIds = new Set(
      getWorkflowIdentityDirectory()
        .users.filter((user) => user.enabled)
        .map((user) => user.id),
    )
    if (!enabledIds.has('local-user')) throw new Error('本机操作人未启用')
    if (command.kind === 'decision' && command.daci) {
      const identities = [
        command.daci.driverId,
        command.daci.approverId,
        ...command.daci.contributorIds,
        ...command.daci.informedIds,
      ]
      if (!identities.every((id) => enabledIds.has(id)))
        throw new Error('DACI 责任人必须是身份目录中已启用的用户 ID')
      if ((command.impactTaskIds ?? []).some((id) => getTask(id)?.projectId !== projectId))
        throw new Error('决策影响任务不属于当前项目')
    }
    if (command.kind === 'approve_decision') {
      const decision = current.decisions.find((item) => item.id === command.decisionId)
      const identities = decision?.daci
        ? [
            decision.daci.driverId,
            decision.daci.approverId,
            ...decision.daci.contributorIds,
            ...decision.daci.informedIds,
          ]
        : []
      if (!decision?.daci || !identities.every((id) => enabledIds.has(id)))
        throw new Error('DACI 责任人缺失或已停用，不能拍板确认')
      if (decision.impactTaskIds.some((id) => getTask(id)?.projectId !== projectId))
        throw new Error('决策影响任务已删除或不属于当前项目')
    }
    if (command.kind === 'set_task_dod' && getTask(command.taskId)?.projectId !== projectId)
      throw new Error('DoD 任务不属于当前项目')
    if (command.kind === 'define_dependency_handoff') {
      const dependency = listTaskDependencies(projectId).find((item) => item.id === command.dependencyId)
      if (
        !dependency ||
        dependency.dependsOnTaskId !== command.upstreamTaskId ||
        dependency.taskId !== command.downstreamTaskId
      )
        throw new Error('依赖交接契约必须绑定当前项目的真实依赖边')
      const upstream = getTask(command.upstreamTaskId)
      const downstream = getTask(command.downstreamTaskId)
      if (
        upstream?.assignee?.userId !== command.providerId ||
        downstream?.assignee?.userId !== command.consumerId
      )
        throw new Error('依赖提供人和接收人必须匹配上下游任务负责人')
      if (!enabledIds.has(command.providerId) || !enabledIds.has(command.consumerId))
        throw new Error('依赖责任人必须已启用')
    }
    if (
      command.kind === 'offer_dependency_handoff' ||
      command.kind === 'accept_dependency_handoff' ||
      command.kind === 'return_dependency_handoff'
    ) {
      const handoff = current.dependencyHandoffs.find((item) => item.dependencyId === command.dependencyId)
      if (!handoff) throw new Error('依赖交接契约不存在')
      if (!enabledIds.has(handoff.providerId) || !enabledIds.has(handoff.consumerId))
        throw new Error('依赖责任人已停用')
    }
    if (command.kind === 'draft') {
      const task = typeof command.taskId === 'string' ? getTask(command.taskId) : undefined
      if (task?.projectId !== projectId) throw new Error('任务不属于当前项目')
      if (!task.assignee?.userId || command.responsibilities?.ownerId !== task.assignee.userId)
        throw new Error('责任快照必须匹配当前任务负责人')
      const roles = command.responsibilities
      if (![roles.ownerId, roles.reviewerId, roles.recipientId].every((id) => enabledIds.has(id)))
        throw new Error('责任人必须是身份目录中已启用的用户 ID')
      if (command.executionId) {
        const execution = getAgentExecution(command.executionId)
        if (
          !execution ||
          execution.projectId !== projectId ||
          execution.entityType !== 'task' ||
          execution.entityId !== task.id ||
          execution.status !== 'completed' ||
          !execution.completedAt
        )
          throw new Error('执行记录必须是该任务已完成的权威 Agent Run')
      } else if (task.assignee.userId.startsWith('agent-')) {
        throw new Error('Agent 负责的任务交付必须关联一次已完成执行记录')
      }
    } else if (
      command.kind === 'submit' ||
      command.kind === 'accept' ||
      command.kind === 'reject' ||
      command.kind === 'request_handoff' ||
      command.kind === 'handoff' ||
      command.kind === 'reject_handoff'
    ) {
      const draft = current.drafts.find((item) => item.id === command.draftId)
      const task = draft ? getTask(draft.taskId) : undefined
      if (!draft || task?.projectId !== projectId) throw new Error('关联任务已删除或不属于当前项目')
      if (draft.responsibilities?.ownerId !== task.assignee?.userId || !task.assignee?.userId)
        throw new Error('任务负责人已变更或未指定，请重新确认责任并保存新版本')
      const roles = draft.responsibilities
      if (!roles || ![roles.ownerId, roles.reviewerId, roles.recipientId].every((id) => enabledIds.has(id)))
        throw new Error('责任信息缺失或责任人已停用，请保存新版本')
    }
    // 主进程确定操作身份，禁止客户端冒充验收人或接收人。
    result = applyChainCommand(current, command, 'local-user')
    getProjectDb()
      .prepare('INSERT INTO project_chain_revisions (project_id, revision, payload) VALUES (?, ?, ?)')
      .run(projectId, result.revision, JSON.stringify(result))
  })()
  if (!result) throw new Error('链路保存失败')
  return result
}
