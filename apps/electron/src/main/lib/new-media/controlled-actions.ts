import { randomUUID } from 'node:crypto'
import type { NewMediaPlatform } from './content-operations'
import { clearNewMediaRecordsForTests, getNewMediaRecord, listNewMediaRecords, putNewMediaRecords } from './new-media-sqlite-store'

export type ControlledActionKind = 'publish' | 'send-reply'
export type ControlledActionStatus = 'pending_approval' | 'approved' | 'simulated' | 'rejected'

export interface ControlledActionRequest {
  id: string
  kind: ControlledActionKind
  platform: NewMediaPlatform
  targetId: string
  summary: string
  status: ControlledActionStatus
  requestedAt: number
  approvedAt?: number
  approvedBy?: string
  executedAt?: number
  simulationReceipt?: string
}

export interface ControlledActionAuditEntry {
  id: string
  actionId: string
  event: 'requested' | 'approved' | 'simulated' | 'rejected'
  actor: string
  createdAt: number
  detail: string
}

const ACTION_KIND = 'controlled-action'
const AUDIT_KIND = 'controlled-action-audit'

function createAudit(actionId: string, event: ControlledActionAuditEntry['event'], actor: string, detail: string): ControlledActionAuditEntry {
  return { id: randomUUID(), actionId, event, actor, createdAt: Date.now(), detail }
}

export async function requestControlledAction(input: Pick<ControlledActionRequest, 'kind' | 'platform' | 'targetId' | 'summary'>, requester = 'local-user'): Promise<ControlledActionRequest> {
  if (!input.targetId.trim() || !input.summary.trim()) throw new Error('操作目标和摘要不能为空')
  const action: ControlledActionRequest = { id: randomUUID(), ...input, status: 'pending_approval', requestedAt: Date.now() }
  const audit = createAudit(action.id, 'requested', requester, '已创建待审批外发请求；当前实现不会连接或操作真实平台。')
  await putNewMediaRecords([{ kind: ACTION_KIND, value: action }, { kind: AUDIT_KIND, value: audit }])
  return action
}

export async function listControlledActions(): Promise<ControlledActionRequest[]> {
  return listNewMediaRecords(ACTION_KIND)
}

export async function approveControlledAction(actionId: string, approver: string): Promise<ControlledActionRequest> {
  const current = await getNewMediaRecord<ControlledActionRequest>(ACTION_KIND, actionId)
  if (!current) throw new Error('外发请求不存在')
  if (!approver.trim()) throw new Error('审批人不能为空')
  if (current.status === 'rejected') throw new Error('已拒绝的请求不能批准')
  if (current.status === 'simulated' || current.status === 'approved') return current
  const approvedBy = approver.trim()
  const approved: ControlledActionRequest = { ...current, status: 'approved', approvedAt: Date.now(), approvedBy }
  const audit = createAudit(actionId, 'approved', approvedBy, '已批准；等待受控执行。')
  await putNewMediaRecords([{ kind: ACTION_KIND, value: approved }, { kind: AUDIT_KIND, value: audit }])
  return approved
}

export async function rejectControlledAction(actionId: string, actor: string, reason: string): Promise<ControlledActionRequest> {
  const current = await getNewMediaRecord<ControlledActionRequest>(ACTION_KIND, actionId)
  if (!current) throw new Error('外发请求不存在')
  if (current.status === 'simulated') throw new Error('已模拟执行的请求不能拒绝')
  if (!actor.trim() || !reason.trim()) throw new Error('拒绝人和原因不能为空')
  const rejected: ControlledActionRequest = { ...current, status: 'rejected' }
  const audit = createAudit(actionId, 'rejected', actor.trim(), reason.trim())
  await putNewMediaRecords([{ kind: ACTION_KIND, value: rejected }, { kind: AUDIT_KIND, value: audit }])
  return rejected
}

export async function simulateControlledAction(actionId: string): Promise<ControlledActionRequest> {
  const current = await getNewMediaRecord<ControlledActionRequest>(ACTION_KIND, actionId)
  if (!current) throw new Error('外发请求不存在')
  if (current.status === 'simulated') return current
  if (current.status !== 'approved') throw new Error('外发请求尚未批准，不能执行')
  const simulated: ControlledActionRequest = { ...current, status: 'simulated', executedAt: Date.now(), simulationReceipt: `simulation:${current.platform}:${current.id}` }
  const audit = createAudit(actionId, 'simulated', 'system:simulation', '已生成模拟平台回执；未发生真实外部发布或消息发送。')
  await putNewMediaRecords([{ kind: ACTION_KIND, value: simulated }, { kind: AUDIT_KIND, value: audit }])
  return simulated
}

export async function getControlledActionAudit(actionId: string): Promise<ControlledActionAuditEntry[]> {
  const entries = await listNewMediaRecords<ControlledActionAuditEntry>(AUDIT_KIND)
  return entries.filter((entry) => entry.actionId === actionId).sort((a, b) => a.createdAt - b.createdAt)
}

export async function resetControlledActionsForTests(): Promise<void> {
  await clearNewMediaRecordsForTests()
}
