import { createHash } from 'node:crypto'
import type { ConfirmOwnerTeamWorkspaceAccessRequest, OwnerTeamWorkspaceProposal } from '@gravitas/shared'
import { getAgentWorkspace, listAgentWorkspaces } from './agent-workspace-manager'
import { canUseOwnerControlledEmployee } from './project-owner-employee-invocation'
import { hasOwnerMixedRuntime } from './project-owner-employee-runtime'
import { validateControlledTarget } from './agent-controlled-context'
import { validateDevelopmentTarget } from './agent-development-context'
import { getChannelById } from './channel-manager'
import { listAgentEmployees } from './agent-employee-service'
import { listProjectWorkspaceBindings, listWorkspaceProjectBindings, bindWorkspaceToProject, hasProjectWorkspaceBinding } from './project-workspace-bindings'
import { getOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { assertLocalActorEnabled, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { getOwnerManagementDelegation } from './project-owner-management-delegation'
import { appendOwnerManagementMessage, getOwnerManagementMessage, getOwnerManagementView, recordOwnerManagementTeamAccessApproved } from './project-owner-management-store'
import { getProjectDb } from './project-sqlite-store'

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function eligibleEmployees(workspaceId: string, ownerCarrierId: string) {
  const workspace = getAgentWorkspace(workspaceId)
  if (!workspace) return []
  const facts = { getChannel: getChannelById, getWorkspace: (id: string) => getAgentWorkspace(id) }
  return listAgentEmployees().filter(employee => {
    const bound = employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : [])
    if (!employee.enabled || employee.id === ownerCarrierId || employee.workflowId
      || !['general', 'controlled', 'development'].includes(employee.executionProfile ?? 'general')
      || !bound.includes(workspaceId) || !hasOwnerMixedRuntime(employee)) return false
    try {
      if ((employee.executionProfile ?? 'general') === 'general') return canUseOwnerControlledEmployee(employee, workspaceId)
      if ((employee.executionProfile ?? 'general') === 'development') validateDevelopmentTarget(employee, workspaceId, facts)
      else validateControlledTarget(employee, workspaceId, facts)
      return true
    } catch { return false }
  })
}

/** 只推荐未授权工作区中至少有两名当前可用于Owner团队的员工，优先扩大最小数据范围。 */
export function getOwnerTeamWorkspaceProposal(projectId: string, taskId?: string): OwnerTeamWorkspaceProposal | null {
  const plan = getProjectOwnerPlanDraft(projectId, taskId)
  const context = getProjectOwnerPlanningContext(projectId, taskId)
  const delegation = getOwnerManagementDelegation(projectId, taskId)
  const binding = getOwnerRuntimeBinding(projectId)
  if (!plan || !['proposed', 'confirmed'].includes(plan.state) || !binding || delegation.state !== 'active' || !delegation.delegation) return null
  const bound = new Set(listProjectWorkspaceBindings(projectId).map(item => item.workspaceId))
  const choices = listAgentWorkspaces().filter(workspace => !bound.has(workspace.id) && listWorkspaceProjectBindings(workspace.id).length === 0)
    .map(workspace => ({ workspace, employees: eligibleEmployees(workspace.id, binding.carrierId) }))
    .filter(item => item.employees.length >= 2)
    .sort((left, right) => left.employees.length - right.employees.length || left.workspace.name.localeCompare(right.workspace.name) || left.workspace.id.localeCompare(right.workspace.id))
  const selected = choices[0]
  if (!selected) return null
  const eligibleEmployeeCount = selected.employees.length
  const scopeFingerprint = hash({ projectId, taskId: taskId ?? null, planRevision: plan.revision, planFingerprint: plan.planFingerprint, contextFingerprint: context.fingerprint, delegationId: delegation.delegation.id, workspace: { id: selected.workspace.id, name: selected.workspace.name, updatedAt: selected.workspace.updatedAt }, employees: selected.employees.map(employee => ({ id: employee.id, enabled: employee.enabled, roleTemplateId: employee.roleTemplateId ?? null, executionProfile: employee.executionProfile ?? 'general', runtime: employee.runtime, workflowId: employee.workflowId ?? null, channelId: employee.channelId, modelId: employee.modelId ?? null, workspaceIds: employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : []) })).sort((a, b) => a.id.localeCompare(b.id)) })
  return { workspaceId: selected.workspace.id, workspaceName: selected.workspace.name, eligibleEmployeeCount, scopeFingerprint }
}

function parseRequest(raw: unknown): ConfirmOwnerTeamWorkspaceAccessRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('团队工作区授权请求无效')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some(key => !['projectId', 'taskId', 'messageId', 'workspaceId', 'scopeFingerprint'].includes(key))
    || typeof value.projectId !== 'string' || !value.projectId.trim()
    || value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId.trim())
    || typeof value.messageId !== 'string' || !/^[a-f0-9]{64}$/.test(value.messageId)
    || typeof value.workspaceId !== 'string' || !value.workspaceId.trim()
    || typeof value.scopeFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.scopeFingerprint)) throw new Error('团队工作区授权请求字段无效')
  return value as unknown as ConfirmOwnerTeamWorkspaceAccessRequest
}

/** 用户只确认项目资料范围；Owner仍负责员工选择、安排与后续推进。 */
export function confirmOwnerTeamWorkspaceAccess(raw: unknown): void {
  const request = parseRequest(raw)
  assertLocalActorEnabled()
  const existingEventId = `team-workspace-approved:${request.messageId}`
  const previousApproval = getOwnerManagementView(request.projectId).messages.find(message => message.eventId === existingEventId && message.role === 'user')
  if (previousApproval) {
    if (previousApproval.teamWorkspaceApproval?.sourceMessageId !== request.messageId || previousApproval.teamWorkspaceApproval.workspaceId !== request.workspaceId || previousApproval.teamWorkspaceApproval.scopeFingerprint !== request.scopeFingerprint) throw new Error('工作区授权请求与已有确认记录不一致')
    if (!hasProjectWorkspaceBinding(request.projectId, request.workspaceId)) throw new Error('已确认的团队工作区后来被移出项目范围；请让Owner重新核对')
    return
  }
  const message = getOwnerManagementMessage(request.projectId, request.messageId)
  if (!message || message.role !== 'assistant' || message.kind !== 'attention' || message.taskId !== request.taskId || !message.teamWorkspaceProposal) throw new Error('Owner工作区建议已不存在或已变化')
  const stored = message.teamWorkspaceProposal
  if (stored.workspaceId !== request.workspaceId || stored.scopeFingerprint !== request.scopeFingerprint) throw new Error('Owner工作区建议已变化，请重新核对')
  const current = getOwnerTeamWorkspaceProposal(request.projectId, request.taskId)
  if (!current || current.workspaceId !== stored.workspaceId || current.scopeFingerprint !== stored.scopeFingerprint) throw new Error('项目目标、团队配置或授权范围已变化，请重新核对')
  const plan = getProjectOwnerPlanDraft(request.projectId, request.taskId)
  if (!plan || !['proposed', 'confirmed'].includes(plan.state)) throw new Error('当前方案已变化；请让Owner按最新方案重新核对')
  const workspace = getAgentWorkspace(current.workspaceId)
  if (!workspace) throw new Error('建议的团队工作区已不可用，项目资料范围未改变')
  getProjectDb().transaction(() => {
    if (!bindWorkspaceToProject(request.projectId, workspace.id)) throw new Error('建议的团队工作区已不可用，项目资料范围未改变')
    appendOwnerManagementMessage({ projectId: request.projectId, eventId: existingEventId, role: 'user', kind: 'conversation', teamWorkspaceApproval: { sourceMessageId: request.messageId, workspaceId: workspace.id, scopeFingerprint: request.scopeFingerprint }, ...(request.taskId ? { taskId: request.taskId } : {}), content: `我确认将工作区“${workspace.name}”纳入本项目可用资料范围。Owner请继续安排当前方案；员工选择与执行仍按原确认边界处理。` })
    recordOwnerManagementTeamAccessApproved(request.projectId, request.taskId, plan.revision, `${request.messageId}:${request.scopeFingerprint}`)
  })()
}
