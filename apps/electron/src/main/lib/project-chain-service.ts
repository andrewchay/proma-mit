import type {
  ProjectChain,
  ProjectChainCommand,
  ProjectDecision,
  ProjectDecisionSourceRef,
  ProjectDeliverableExecution,
} from '@gravitas/shared'
import {
  getAgentExecution,
  getProject,
  getProjectDb,
  getTask,
  listTaskDependencies,
} from './project-sqlite-store'
import { applyChainCommand, emptyProjectChain } from './project-chain'
import { getWorkflowIdentityDirectory } from './workflow-identity-service'

function normalizeSourceRefs(value: unknown): ProjectDecisionSourceRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      return [{ sourceType: 'legacy' as const, sourceId: item, locator: item }]
    }
    if (!item || typeof item !== 'object') return []
    const ref = item as Partial<ProjectDecisionSourceRef>
    if (!ref.sourceType || !ref.sourceId || !ref.locator) return []
    return [{
      sourceType: ref.sourceType,
      sourceId: ref.sourceId,
      locator: ref.locator,
      ...(ref.checksum ? { checksum: ref.checksum } : {}),
    }]
  })
}

function normalizeDecision(decision: ProjectDecision): ProjectDecision {
  return {
    ...decision,
    status: decision.status ?? 'decided',
    impactTaskIds: decision.impactTaskIds ?? [],
    alternatives: decision.alternatives ?? [],
    assumptions: decision.assumptions ?? [],
    sourceRefs: normalizeSourceRefs(decision.sourceRefs),
  }
}

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
    taskDodAutoAcceptance: parsed.taskDodAutoAcceptance ?? {},
    dependencyHandoffs: parsed.dependencyHandoffs ?? [],
    serviceLevelDays: parsed.serviceLevelDays ?? 7,
    decisions: (parsed.decisions ?? []).map(normalizeDecision),
    decisionHistory: (parsed.decisionHistory ?? []).map(normalizeDecision),
    drafts: (parsed.drafts ?? []).map((draft) => ({
      ...draft,
      definitionOfDone: draft.definitionOfDone ?? [],
      dodCheckResults: draft.dodCheckResults ?? [],
    })),
    draftHistory: (parsed.draftHistory ?? []).map((draft) => ({
      ...draft,
      definitionOfDone: draft.definitionOfDone ?? [],
      dodCheckResults: draft.dodCheckResults ?? [],
    })),
  } as ProjectChain
}

/** 在同一事务内校验版本、项目归属并追加快照，拒绝覆盖并发更新。 */
/** 员工 principal 前缀（与 agent-employee-service 的 AGENT_ASSIGNEE_PREFIX 语义一致） */
const AGENT_PRINCIPAL_PREFIX = 'agent-'

function isAgentPrincipal(userId: string): boolean {
  return userId.startsWith(AGENT_PRINCIPAL_PREFIX)
}

/**
 * 交付责任校验：reviewer/recipient 必须是目录内已启用人类；
 * ownerId 为员工 principal（agent-<id>）时由员工档案校验代管，不要求进目录。
 */
function deliveryRolesAreEnabled(
  roles: { ownerId: string; reviewerId: string; recipientId: string },
  enabledIds: Set<string>,
): boolean {
  const humanIds = [roles.reviewerId, roles.recipientId, ...isAgentPrincipal(roles.ownerId) ? [] : [roles.ownerId]]
  return humanIds.every((id) => enabledIds.has(id))
}

export function updateProjectChain(
  projectId: string,
  expectedRevision: number,
  command: ProjectChainCommand,
): ProjectChain {
  return updateProjectChainAsActor(projectId, expectedRevision, command, 'local-user')
}

/**
 * 以显式操作人应用链路命令。公共人工入口固定 local-user；
 * 研发员工受限提交使用 agent-<id> 身份，必须先由交付服务验证员工档案（W03）。
 */
export function updateProjectChainAsActor(
  projectId: string,
  expectedRevision: number,
  command: ProjectChainCommand,
  actor: string,
): ProjectChain {
  let result: ProjectChain | undefined
  getProjectDb().transaction(() => {
    let linkedExecution: ProjectDeliverableExecution | undefined
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
    if (actor !== 'local-user') {
      // 操作人 principal 二选一：真实、启用且研发档案的员工（受限交付），或身份目录内已启用人类（内部验收/交接服务）。
      // 公共 IPC 入口 updateProjectChain 固定 local-user，客户端无法冒充任一身份。
      const employeeId = actor.startsWith('agent-') ? actor.slice('agent-'.length) : ''
      const employee = employeeId
        ? (require('./project-sqlite-store') as typeof import('./project-sqlite-store')).getAgentEmployee(employeeId)
        : null
      const isEmployeePrincipal = Boolean(employee?.enabled && employee.executionProfile === 'development')
      const isDirectoryUser = enabledIds.has(actor)
      if (!isEmployeePrincipal && !isDirectoryUser) {
        throw new Error('无效的员工操作身份')
      }
    }
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
    if (
      (command.kind === 'set_task_dod' || command.kind === 'set_task_dod_auto_acceptance') &&
      getTask(command.taskId)?.projectId !== projectId
    )
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
      // 员工 ownerId 的有效性由 updateProjectChainAsActor 的员工档案校验保证；
      // 身份目录只覆盖人类角色（reviewer/recipient）。
      if (!deliveryRolesAreEnabled(roles, enabledIds))
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
        linkedExecution = {
          id: execution.id,
          agentId: execution.agentId,
          sessionId: execution.sessionId,
          completedAt: execution.completedAt,
        }
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
      if (!roles || !deliveryRolesAreEnabled(roles, enabledIds))
        throw new Error('责任信息缺失或责任人已停用，请保存新版本')
    }
    // 主进程确定操作身份，禁止客户端冒充验收人或接收人。
    result = applyChainCommand(current, command, actor, { suppressDodAutoAccept: actor !== 'local-user' })
    if (command.kind === 'draft' && linkedExecution) {
      const draft = result.drafts.find((item) => item.executionId === linkedExecution?.id)
      if (!draft) throw new Error('交付物未关联到已验证执行记录')
      draft.execution = structuredClone(linkedExecution)
      const history = result.draftHistory.find(
        (item) => item.id === draft.id && item.version === draft.version,
      )
      if (history) history.execution = structuredClone(linkedExecution)
    }
    getProjectDb()
      .prepare('INSERT INTO project_chain_revisions (project_id, revision, payload) VALUES (?, ?, ?)')
      .run(projectId, result.revision, JSON.stringify(result))
  })()
  if (!result) throw new Error('链路保存失败')
  return result
}
