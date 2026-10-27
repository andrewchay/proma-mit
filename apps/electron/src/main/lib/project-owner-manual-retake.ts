/**
 * 用户手动要求重新安排人员。
 *
 * 只排队一个 assignment_recheck 事件，不改目标、方案、授权或预算；
 * 后续同自动重排走同一条受控链路（含 readiness、预算与 start 门禁）。
 */
import { assertLocalActorEnabled, getProjectOwnerPlanDraft, getProjectOwnerPlanningContext } from './project-owner-plan-service'
import { getOwnerManagementDelegation, hasActiveOwnerManagementRequest } from './project-owner-management-delegation'
import { getOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { recordOwnerManagementManualRecheck } from './project-owner-management-store'
import { requestOwnerManagementWake } from './project-owner-management-events'

export interface ManualRetakeInput { projectId: string; taskId?: string; requestId: string }

function parse(raw: unknown): ManualRetakeInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('重排请求必须是对象')
  const value = raw as Record<string, unknown>
  const allowed = ['projectId', 'taskId', 'requestId']
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('重排请求含有未知字段')
  for (const key of ['projectId', 'requestId', ...(value.taskId === undefined ? [] : ['taskId'])]) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim() || value[key].length > 128) throw new Error('重排请求身份无效')
  }
  return { projectId: value.projectId as string, requestId: value.requestId as string, ...(typeof value.taskId === 'string' ? { taskId: value.taskId } : {}) }
}

export function retakeOwnerManagementAssignment(raw: unknown): { enqueued: boolean } {
  const input = parse(raw)
  assertLocalActorEnabled()
  const plan = getProjectOwnerPlanDraft(input.projectId, input.taskId)
  if (!plan || plan.state !== 'confirmed') throw new Error('当前没有已确认方案，无法重新安排人员')
  const context = getProjectOwnerPlanningContext(input.projectId, input.taskId)
  if (context.goal.revision !== plan.goalRevision) throw new Error('项目目标已更新，请先核对当前方案')
  const delegation = getOwnerManagementDelegation(input.projectId, input.taskId)
  if (delegation.state !== 'active' || !delegation.delegation) throw new Error(delegation.detail || '项目管理授权不可用，需先重新确认额度')
  if (delegation.delegation.expiresAt <= Date.now()) throw new Error('项目管理授权已到期，需先重新确认额度')
  if (!getOwnerRuntimeBinding(input.projectId)) throw new Error('Owner 运行配置缺失，无法重排')
  if (hasActiveOwnerManagementRequest(delegation.delegation.id)) return { enqueued: false }
  const event = recordOwnerManagementManualRecheck(input.projectId, plan.revision, input.requestId, input.taskId)
  requestOwnerManagementWake(input.projectId)
  return { enqueued: Boolean(event.id) }
}
