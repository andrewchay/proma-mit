/**
 * 研发受限员工交付服务（W03）。
 *
 * 职责：权威执行完成回调触发的唯一员工提交链路——冻结快照 → 创建/续版交付 →
 * 提交到 submitted（强制停住，不自动验收）。
 * 边界：
 * - 只有主进程完成回调能调用；不暴露给 renderer，不作为员工工具注册；
 * - 员工 principal 仅来源于真实执行记录与员工档案，客户端 actor 不可伪造（T17）；
 * - 员工只能交付，不能验收：accept/reject 的 expectedActor 是人类 reviewer（T13）；
 * - 决策必须真实存在且已拍板，不自动捏造（T15 在派发入口拦截，此处兜底校验）；
 * - 同一 execution 重放幂等（T18）；同任务返工沿用同一 deliverableId 的新版本（D2）。
 */

import type { ProjectChain, ProjectChainCommand, ProjectDeliverable } from '@gravitas/shared'
import {
  getAgentEmployee,
  getAgentExecution,
  getTask,
} from './project-sqlite-store'
import { getProjectChain, updateProjectChainAsActor } from './project-chain-service'
import { getWorkflowIdentityDirectory } from './workflow-identity-service'
import { getAgentSessionMeta } from './agent-session-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { resolveDevelopmentWorktree } from './agent-development-worktree'
import { createDevelopmentSnapshot, loadDevelopmentSnapshot } from './development-snapshot-service'
import { validateDevelopmentScope } from './development-task-service'
import { AGENT_ASSIGNEE_PREFIX } from './agent-employee-service'

export interface DevelopmentDeliveryResult {
  deliveryId: string
  version: number
  status: string
  snapshotId: string
  executionId: string
  taskId: string
}

export class DevelopmentDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevelopmentDeliveryError'
  }
}

/** 从统一指派 ID 解析员工 ID（与 agent-employee-service 语义一致；此处仅读前缀，避免加载期循环依赖） */
function agentIdFromAssignee(assigneeUserId: string | undefined): string | null {
  return assigneeUserId?.startsWith(AGENT_ASSIGNEE_PREFIX) ? assigneeUserId.slice(AGENT_ASSIGNEE_PREFIX.length) || null : null
}

/**
 * 为一次已完成的研发执行提交交付（draft → submit，停在 submitted）。
 * 任何校验失败抛 DevelopmentDeliveryError，由完成回调记录到 execution.error，
 * 不影响任务回写主流程。
 */
export function submitDevelopmentDelivery(executionId: string): DevelopmentDeliveryResult {
  const execution = getAgentExecution(executionId)
  if (!execution) throw new DevelopmentDeliveryError('执行记录不存在')
  if (execution.entityType !== 'task') throw new DevelopmentDeliveryError('仅支持主任务研发交付')
  if (execution.status !== 'completed' || !execution.completedAt) {
    throw new DevelopmentDeliveryError('只有已完成的执行才能提交交付')
  }

  const task = getTask(execution.entityId)
  if (!task || task.projectId !== execution.projectId) throw new DevelopmentDeliveryError('任务与执行记录不匹配')
  if (agentIdFromAssignee(task.assignee?.userId) !== execution.agentId) {
    throw new DevelopmentDeliveryError('任务负责人已变更，拒绝旧运行交付')
  }
  const employee = getAgentEmployee(execution.agentId)
  if (!employee?.enabled || employee.executionProfile !== 'development') {
    throw new DevelopmentDeliveryError('员工不存在、已停用或不是研发档案')
  }
  if (!task.developmentScope) throw new DevelopmentDeliveryError('任务缺少研发执行范围')

  // 范围与验收人校验：验收人必须是身份目录中已启用的非 Agent 用户
  const scope = validateDevelopmentScope(task.developmentScope, { getWorkspace: (id) => getAgentWorkspace(id) })
  const reviewerId = scope.reviewerId
  if (!reviewerId) throw new DevelopmentDeliveryError('缺少人工验收人')
  if (reviewerId.startsWith(AGENT_ASSIGNEE_PREFIX)) throw new DevelopmentDeliveryError('人工验收人不能是 AI 员工')
  const reviewerEnabled = getWorkflowIdentityDirectory().users.some((user) => user.id === reviewerId && user.enabled)
  if (!reviewerEnabled) throw new DevelopmentDeliveryError(`验收人 ${reviewerId} 不在身份目录或已停用`)

  const chain = getProjectChain(execution.projectId)

  // 幂等：同一 execution 已有交付版本——draft 续推，其余直接返回既有结果
  const known = [...chain.drafts, ...chain.draftHistory]
    .filter((draft) => draft.executionId === executionId)
    .sort((a, b) => b.version - a.version)[0]
  if (known) {
    if (known.status === 'draft' && chain.drafts.some((draft) => draft.id === known.id)) {
      const submitted = submitDraft(execution.projectId, known.id, execution.agentId, chain.revision)
      return { deliveryId: known.id, version: submitted.version, status: submitted.status, snapshotId: snapshotIdOf(known), executionId, taskId: task.id }
    }
    return { deliveryId: known.id, version: known.version, status: known.status, snapshotId: snapshotIdOf(known), executionId, taskId: task.id }
  }

  // 决策兜底校验：引用的决策必须存在、已拍板
  const decisionIds = scope.decisionIds ?? []
  if (!decisionIds.length) throw new DevelopmentDeliveryError('缺少关联决策：请在派发前关联或确认真实决策')
  for (const decisionId of decisionIds) {
    const decision = chain.decisions.find((item) => item.id === decisionId)
    if (!decision) throw new DevelopmentDeliveryError(`关联决策不存在：${decisionId}`)
    if (decision.status !== 'decided') throw new DevelopmentDeliveryError(`关联决策尚未拍板：${decision.title}`)
  }

  // 冻结快照：worktree 必须仍然绑定本会话
  const sessionMeta = execution.sessionId ? getAgentSessionMeta(execution.sessionId) : undefined
  const workspace = sessionMeta?.workspaceId ? getAgentWorkspace(sessionMeta.workspaceId) : undefined
  if (!workspace?.rootPath) throw new DevelopmentDeliveryError('研发工作区已失效，不能冻结交付')
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
  const worktreePath = resolveDevelopmentWorktree(workspace.rootPath, sessionDirectory)
  if (!worktreePath) throw new DevelopmentDeliveryError('研发 worktree 绑定缺失，不能在主仓库交付')

  const snapshot = createDevelopmentSnapshot({
    worktreePath, sessionDirectory, executionId, workspaceId: workspace.id,
    scope: task.developmentScope,
  })
  // 立即回读校验：清单与内容指纹必须自洽（T30 前置）
  loadDevelopmentSnapshot(sessionDirectory, executionId)
  if (!snapshot.files.length) throw new DevelopmentDeliveryError('快照没有变更，无可交付内容')

  const ownerId = `${AGENT_ASSIGNEE_PREFIX}${execution.agentId}`
  // 同任务已有交付时沿用同一 deliverableId 的新版本；首版则新建
  const previous = chain.drafts
    .filter((draft) => draft.taskId === task.id)
    .sort((a, b) => b.version - a.version)[0]

  const draftCommand: ProjectChainCommand = {
    kind: 'draft',
    taskId: task.id,
    title: `研发交付：${task.title}`,
    content: execution.resultSummary?.trim() || '（员工未返回结果摘要）',
    criteria: reviewerCriteria(scope),
    recipient: reviewerId,
    responsibilities: { ownerId, reviewerId, recipientId: reviewerId },
    decisionIds,
    executionId: execution.id,
    artifactRef: `development-snapshot:${snapshot.id}:${snapshot.contentHash}`,
    ...(previous ? { draftId: previous.id, changeReason: `研发返工交付（execution ${executionId}）` } : {}),
  }
  const afterDraft = updateProjectChainAsActor(execution.projectId, chain.revision, draftCommand, ownerId)
  const draft = [...afterDraft.drafts, ...afterDraft.draftHistory]
    .filter((item) => item.executionId === executionId)
    .sort((a, b) => b.version - a.version)[0]
  if (!draft) throw new DevelopmentDeliveryError('交付版本创建失败')

  const submitted = submitDraft(execution.projectId, draft.id, execution.agentId, afterDraft.revision)
  return { deliveryId: draft.id, version: submitted.version, status: submitted.status, snapshotId: snapshot.id, executionId, taskId: task.id }
}

/** 验收标准占位：首版以验证命令为人工核对线索，不为空串（draft 契约要求非空） */
function reviewerCriteria(scope: ReturnType<typeof validateDevelopmentScope>): string {
  const commands = scope.verificationCommands?.join('；')
  return commands ? `按验证命令核对：${commands}` : '人工核对变更内容与交付说明'
}

function snapshotIdOf(draft: ProjectDeliverable): string {
  const ref = draft.artifactRef ?? ''
  return ref.startsWith('development-snapshot:') ? ref.split(':')[1] ?? '' : ''
}

/** 受限提交：员工只能把自己的 draft 推到 submitted，强制停住不自动验收 */
function submitDraft(projectId: string, draftId: string, agentId: string, expectedRevision: number): ProjectDeliverable {
  const command: ProjectChainCommand = { kind: 'submit', draftId }
  const chain = updateProjectChainAsActor(projectId, expectedRevision, command, `${AGENT_ASSIGNEE_PREFIX}${agentId}`)
  const draft = chain.drafts.find((item) => item.id === draftId)
  if (!draft) throw new DevelopmentDeliveryError('提交后交付版本丢失')
  if (draft.status === 'accepted') throw new DevelopmentDeliveryError('研发受限路径不允许自动验收')
  if (draft.status !== 'submitted') throw new DevelopmentDeliveryError(`交付未能到达 submitted：${draft.status}`)
  return draft
}

/** 供完成回调判断是否启用受限交付：仅研发任务配置了完整范围时返回 true */
export function shouldSubmitDevelopmentDelivery(task: { assignee?: { userId?: string }; developmentScope?: unknown } | null | undefined): boolean {
  return Boolean(task?.assignee?.userId?.startsWith(AGENT_ASSIGNEE_PREFIX) && task.developmentScope)
}

export type { ProjectChain }
