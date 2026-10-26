/**
 * 研发 Review 服务（M2 / W05+W06 主进程侧）。
 *
 * 职责：Review 查询汇总、冻结快照 Diff 读取、文件委派准备、人工验收/退回、幂等返工。
 * 边界：
 * - 公共人工操作固定 local-user；验收人不是 local-user 时明确拒绝，不代其他身份验收；
 * - 退回意见必填，且直接驱动幂等派发（沿用既有 dispatchTaskToAgentIfIdle 去重）；
 * - 快照 Diff 只读取会话私有目录中的冻结内容，不读 live worktree。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DevelopmentSnapshot,
  DevelopmentSnapshotDiff,
  PrepareFileDelegationInput,
  TaskReviewDelivery,
  TaskReviewSummary,
} from '@gravitas/shared'
type ReviewDodResult = { criterion: string; status: string; mode?: string; checkedBy?: string }
import {
  getAgentEmployee,
  getAgentExecution,
  listAgentExecutionsByEntity,
  getTask as getTaskRaw,
} from './project-sqlite-store'
import { createTask as createTaskWithEvents, updateTask as updateTaskWithEvents, getTask as getTaskAsync } from './project-service'
import { getProjectChain, updateProjectChain } from './project-chain-service'
import { getWorkflowIdentityDirectory } from './workflow-identity-service'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import {
  setTaskDevelopmentScope,
  validateDevelopmentScope,
} from './development-task-service'
import { loadDevelopmentSnapshot } from './development-snapshot-service'
import { parseAgentId, isAgentAssignee, dispatchTaskToAgentIfIdle } from './agent-employee-service'
import {
  assertNoOwnerBusinessTask,
  assertNoOwnerBusinessExecution,
  assertNoOwnerBusinessSession,
} from './project-owner-task-evidence'

/** 只限制准确任务及其执行/会话残余；同项目的其他任务与只读Review不受影响。 */
function assertLegacyReviewTaskPurpose(taskId: string): void {
  assertNoOwnerBusinessTask(taskId)
  for (const execution of listAgentExecutionsByEntity('task', taskId)) {
    if (execution.sessionId) assertNoOwnerBusinessSession(execution.sessionId)
    assertNoOwnerBusinessExecution(execution.id)
  }
}

export class DevelopmentReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevelopmentReviewError'
  }
}


function toReviewDodResult(result: ReviewDodResult): ReviewDodResult {
  return {
    criterion: result.criterion,
    status: result.status,
    ...(result.mode ? { mode: result.mode } : {}),
    ...(result.checkedBy ? { checkedBy: result.checkedBy } : {}),
  }
}

/** 统一读任务：优先走带事件的 project-service（保持与 UI/同步层一致的读写路径）。 */
async function getTask(taskId: string) {
  return (await getTaskAsync(taskId)) ?? getTaskRaw(taskId)
}

/** 文件委派准备：校验并落库（新建或关联任务），不派发执行。 */
export async function prepareFileDelegation(input: PrepareFileDelegationInput): Promise<{ taskId: string; created: boolean }> {
  if (input.existingTaskId) assertLegacyReviewTaskPurpose(input.existingTaskId)
  const employee = getAgentEmployee(input.employeeId)
  if (!employee?.enabled || employee.executionProfile !== 'development') {
    throw new DevelopmentReviewError('AI 员工不存在、已停用或不是研发档案')
  }
  const availableWorkspaces = employee.workspaceIds?.length ? employee.workspaceIds : employee.workspaceId ? [employee.workspaceId] : []
  if (!availableWorkspaces.includes(input.workspaceId)) {
    throw new DevelopmentReviewError('所选工作区不在该研发员工的可用范围内')
  }

  const reviewerId = input.reviewerId?.trim() || 'local-user'
  if (reviewerId.startsWith('agent-')) throw new DevelopmentReviewError('人工验收人不能是 AI 员工')
  if (!getWorkflowIdentityDirectory().users.some((user) => user.id === reviewerId && user.enabled)) {
    throw new DevelopmentReviewError(`验收人 ${reviewerId} 不在身份目录或已停用`)
  }

  const task = input.existingTaskId ? await getTask(input.existingTaskId) : undefined
  if (input.existingTaskId) assertLegacyReviewTaskPurpose(input.existingTaskId)
  if (input.existingTaskId && !task) throw new DevelopmentReviewError('要关联的任务不存在')
  if (task && task.projectId !== input.projectId) throw new DevelopmentReviewError('任务不属于当前项目')
  if (task && isAgentAssignee(task) && parseAgentId(task.assignee?.userId) !== input.employeeId) {
    throw new DevelopmentReviewError('任务已指派给其他 AI 员工，请新建任务')
  }
  if (!input.existingTaskId && !input.newTask?.title?.trim()) {
    throw new DevelopmentReviewError('新建任务需要标题')
  }

  const scope = {
    workspaceId: input.workspaceId,
    targetPaths: input.targetPaths ?? [],
    allowedPaths: input.allowedPaths ?? [],
    reviewerId,
    decisionIds: input.decisionIds ?? [],
    verificationCommands: input.verificationCommands ?? [],
  }
  const validated = validateDevelopmentScope(scope, { getWorkspace: (id) => getAgentWorkspace(id) })
  if (!validated.decisionIds?.length) {
    throw new DevelopmentReviewError('请选择至少一条已拍板的真实决策；不伪造审批')
  }
  // 决策必须存在且已拍板（T15 前置）
  const chain = getProjectChain(input.projectId)
  for (const decisionId of validated.decisionIds!) {
    const decision = chain.decisions.find((item) => item.id === decisionId)
    if (!decision) throw new DevelopmentReviewError(`关联决策不存在：${decisionId}`)
    if (decision.status !== 'decided') throw new DevelopmentReviewError(`关联决策尚未拍板：${decision.title}`)
  }

  if (task) {
    const updated = setTaskDevelopmentScope(task.id, scope, { confirmHumanReassign: input.confirmHumanReassign === true }, { getWorkspace: (id) => getAgentWorkspace(id) })
    return { taskId: updated.id, created: false }
  }
  const created = await createTaskWithEvents(input.projectId, {
    title: input.newTask!.title.trim(),
    description: input.newTask?.description ?? '',
    workspaceId: input.workspaceId,
    developmentScope: validated,
    assignee: { userId: `agent-${input.employeeId}`, displayName: employee.name },
  })
  return { taskId: created.id, created: true }
}

/** 读取任务 Review 汇总（不解释运行终态为业务验收）。 */
export async function getTaskReview(taskId: string): Promise<TaskReviewSummary> {
  const task = await getTask(taskId)
  if (!task) throw new DevelopmentReviewError('任务不存在')
  const chain = getProjectChain(task.projectId)
  const deliveries: TaskReviewDelivery[] = [
    ...chain.drafts, ...chain.draftHistory,
  ]
    .filter((draft) => draft.taskId === taskId)
    .sort((a, b) => b.version - a.version || b.at - a.at)
    .map((draft) => ({
      id: draft.id,
      version: draft.version,
      status: draft.status,
      title: draft.title,
      content: draft.content,
      ...(draft.artifactRef ? { artifactRef: draft.artifactRef } : {}),
      ...(draft.executionId ? { executionId: draft.executionId } : {}),
      ...(draft.responsibilities ? { responsibilities: { ...draft.responsibilities } } : {}),
      ...(draft.dodCheckResults?.length ? { dodCheckResults: draft.dodCheckResults.map(toReviewDodResult) } : {}),
      ...(draft.acceptedCriteria?.length ? { acceptedCriteria: [...draft.acceptedCriteria] } : {}),
      createdAt: draft.at,
      ...(draft.actor ? { actor: draft.actor } : {}),
    }))
  const executions = listAgentExecutionsByEntity('task', taskId)
  // 同一交付 id 的历史版本去重：draftHistory 含旧版本，Review 页按 (id, version) 展示全部
  return {
    taskId: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    ...(task.completionNotes ? { completionNotes: task.completionNotes } : {}),
    scope: (task.developmentScope ?? null),
    executions: executions.map(toExecutionResult),
    deliveries,
    decidedDecisions: chain.decisions
      .filter((decision) => decision.status === 'decided')
      .map((decision) => ({ id: decision.id, title: decision.title, version: decision.version })),
    reviewerId: task.developmentScope?.reviewerId ?? 'local-user',
    snapshots: buildSnapshots(executions),
  }
}

/** 主进程执行记录 → 共享可序列化投影（TaskReviewSummary 消费端只依赖共享类型）。 */
function toExecutionResult(execution: ReturnType<typeof listAgentExecutionsByEntity>[number]): import('@gravitas/shared').AgentExecutionResult {
  return {
    id: execution.id,
    projectId: execution.projectId,
    entityType: execution.entityType,
    entityId: execution.entityId,
    agentId: execution.agentId,
    sessionId: execution.sessionId,
    status: execution.status,
    prompt: execution.prompt,
    ...(execution.resultSummary ? { resultSummary: execution.resultSummary } : {}),
    outputFiles: execution.outputFiles ?? [],
    ...(execution.riskLevel ? { riskLevel: execution.riskLevel } : {}),
    ...(execution.error ? { error: execution.error } : {}),
    requestedPermissions: execution.requestedPermissions ?? [],
    ...(execution.capabilityVersionIds?.length ? { capabilityVersionIds: execution.capabilityVersionIds } : {}),
    ...(execution.capabilityContentHash ? { capabilityContentHash: execution.capabilityContentHash } : {}),
    startedAt: execution.startedAt,
    ...(execution.completedAt ? { completedAt: execution.completedAt } : {}),
  }
}

/** 收集已完成执行的冻结快照清单；缺失/损坏的快照不阻塞 Review，由前端标记不可用。 */
function buildSnapshots(executions: ReturnType<typeof listAgentExecutionsByEntity>): TaskReviewSummary['snapshots'] {
  const snapshots: TaskReviewSummary['snapshots'] = []
  for (const execution of executions) {
    if (execution.status !== 'completed' || !execution.sessionId || execution.sessionId.startsWith('workflow:')) continue
    const meta = getAgentSessionMeta(execution.sessionId)
    const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
    if (!workspace) continue
    try {
      const snapshot = loadDevelopmentSnapshot(getAgentSessionWorkspacePath(workspace.slug, execution.sessionId), execution.id)
      snapshots.push({ executionId: execution.id, baseCommit: snapshot.baseCommit, contentHash: snapshot.contentHash, files: snapshot.files })
    } catch {
      // 快照缺失/损坏：不阻塞 Review 主信息，Diff 打开时会得到明确错误
    }
  }
  return snapshots
}

/** 读取冻结快照中某文件的新旧内容（只读会话私有目录，不读 live worktree）。 */
export function getSnapshotDiff(executionId: string, filePath: string): DevelopmentSnapshotDiff {
  const execution = getAgentExecution(executionId)
  if (!execution || execution.entityType !== 'task') throw new DevelopmentReviewError('执行记录不存在')
  const task = getTaskRaw(execution.entityId)
  if (!task?.developmentScope) throw new DevelopmentReviewError('任务缺少研发执行范围')
  const sessionMeta = execution.sessionId ? getAgentSessionMeta(execution.sessionId) : undefined
  const workspace = sessionMeta?.workspaceId ? getAgentWorkspace(sessionMeta.workspaceId) : undefined
  if (!workspace) throw new DevelopmentReviewError('研发工作区已失效')
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  let snapshot: DevelopmentSnapshot
  try {
    snapshot = loadDevelopmentSnapshot(sessionDirectory, executionId)
  } catch (error) {
    throw new DevelopmentReviewError(error instanceof Error ? error.message : String(error))
  }
  const file = snapshot.files.find((item) => item.path === filePath)
  if (!file) throw new DevelopmentReviewError(`快照中没有该文件：${filePath}`)
  const contentsDir = join(sessionDirectory, `development-snapshot-${executionId}.d`)
  const index = snapshot.files.indexOf(file)
  const read = (suffix: '.old' | '.new'): string | null => {
    const path = join(contentsDir, `${index}${suffix}`)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  return {
    path: file.path,
    changeType: file.changeType,
    oldContent: file.changeType === 'add' ? null : read('.old'),
    newContent: file.changeType === 'delete' ? null : read('.new'),
    truncated: false,
  }
}

/** 人工验收通过：local-user 必须是登记的验收人；证据必填。 */
export async function acceptDelivery(taskId: string, deliveryId: string, input: { evidence: string; completedCriteria?: string[] }): Promise<unknown> {
  assertLegacyReviewTaskPurpose(taskId)
  const task = await getTask(taskId)
  assertLegacyReviewTaskPurpose(taskId)
  if (!task) throw new DevelopmentReviewError('任务不存在')
  if (!input.evidence?.trim()) throw new DevelopmentReviewError('验收通过必须提供依据')
  const chain = getProjectChain(task.projectId)
  const draft = chain.drafts.find((item) => item.id === deliveryId)
  if (!draft) throw new DevelopmentReviewError('交付版本不存在')
  const reviewerId = draft.responsibilities?.reviewerId ?? 'local-user'
  if (reviewerId !== 'local-user') {
    throw new DevelopmentReviewError(`当前验收人是 ${reviewerId}，本机 local-user 不能代为验收`)
  }
  return updateProjectChain(task.projectId, chain.revision, {
    kind: 'accept',
    draftId: deliveryId,
    comment: input.evidence.trim(),
    evidence: input.evidence.trim(),
    ...(input.completedCriteria?.length ? { completedCriteria: input.completedCriteria } : {}),
  })
}

/** 人工退回：意见必填；历史版本不变。 */
export async function rejectDelivery(taskId: string, deliveryId: string, comment: string): Promise<unknown> {
  const task = await getTask(taskId)
  if (!task) throw new DevelopmentReviewError('任务不存在')
  const trimmed = comment?.trim()
  if (!trimmed) throw new DevelopmentReviewError('退回必须填写原因')
  const chain = getProjectChain(task.projectId)
  const draft = chain.drafts.find((item) => item.id === deliveryId)
  if (!draft) throw new DevelopmentReviewError('交付版本不存在')
  const reviewerId = draft.responsibilities?.reviewerId ?? 'local-user'
  if (reviewerId !== 'local-user') {
    throw new DevelopmentReviewError(`当前验收人是 ${reviewerId}，本机 local-user 不能代为退回`)
  }
  return updateProjectChain(task.projectId, chain.revision, { kind: 'reject', draftId: deliveryId, comment: trimmed })
}

/**
 * 幂等返工：记录人工意见并派发（沿用原会话/worktree，由既有调度去重）。
 * 返回是否真正派发；已有进行中执行时返回 null（意见已保存）。
 */
export async function requestChanges(taskId: string, comment: string): Promise<{ taskId: string } | null> {
  assertLegacyReviewTaskPurpose(taskId)
  const task = await getTask(taskId)
  assertLegacyReviewTaskPurpose(taskId)
  if (!task) throw new DevelopmentReviewError('任务不存在')
  if (!task.developmentScope) throw new DevelopmentReviewError('任务缺少研发执行范围')
  const trimmed = comment?.trim()
  if (!trimmed) throw new DevelopmentReviewError('返工意见不能为空')
  // 暂停/待验收 → 可执行态；意见写回 completionNotes 供执行上下文读取（buildDevelopmentInstructions）。
  // 走带事件的更新：任务变化会经 auto-sync 幂等派发；这里的显式派发是确定性兑底（IfIdle 去重）。
  const updated = await updateTaskWithEvents(taskId, { status: 'pending', completionNotes: trimmed }, { source: 'system' })
  if (!updated) throw new DevelopmentReviewError('任务状态回写失败')
  return dispatchTaskToAgentIfIdle(updated)
}
