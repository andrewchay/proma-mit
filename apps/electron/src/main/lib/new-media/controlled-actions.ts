import { randomUUID } from 'node:crypto'
import type { NewMediaPlatform } from './content-operations'
import type { NewMediaAuditEntry } from './new-media-audit'
import { appendNewMediaAudit, createNewMediaAuditEntry, listNewMediaAudit } from './new-media-audit'
import { clearNewMediaRecordsForTests, getNewMediaRecord, listNewMediaRecords } from './new-media-sqlite-store'

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

/** 受控外发审计统一写入 new-media-audit，读取时映射回既有形状。 */
function createAudit(actionId: string, event: ControlledActionAuditEntry['event'], actor: string, detail: string, metadata?: Record<string, unknown>) {
  return createNewMediaAuditEntry({ domain: 'governance', event, actor, subjectId: actionId, detail, metadata })
}

async function persistAction(record: ControlledActionRequest, entry: Promise<NewMediaAuditEntry>): Promise<void> {
  await appendNewMediaAudit(await entry, [{ kind: ACTION_KIND, value: record }])
}

export async function requestControlledAction(input: Pick<ControlledActionRequest, 'kind' | 'platform' | 'targetId' | 'summary'>, requester = 'local-user'): Promise<ControlledActionRequest> {
  if (!input.targetId.trim() || !input.summary.trim()) throw new Error('操作目标和摘要不能为空')
  const action: ControlledActionRequest = { id: randomUUID(), ...input, status: 'pending_approval', requestedAt: Date.now() }
  await persistAction(action, createAudit(action.id, 'requested', requester, '已创建待审批外发请求；当前实现不会连接或操作真实平台。', {
    kind: action.kind,
    platform: action.platform,
  }))
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
  await persistAction(approved, createAudit(actionId, 'approved', approvedBy, '已批准；等待受控执行。', { platform: current.platform }))
  return approved
}

export async function rejectControlledAction(actionId: string, actor: string, reason: string): Promise<ControlledActionRequest> {
  const current = await getNewMediaRecord<ControlledActionRequest>(ACTION_KIND, actionId)
  if (!current) throw new Error('外发请求不存在')
  if (current.status === 'simulated') throw new Error('已模拟执行的请求不能拒绝')
  if (!actor.trim() || !reason.trim()) throw new Error('拒绝人和原因不能为空')
  const rejected: ControlledActionRequest = { ...current, status: 'rejected' }
  await persistAction(rejected, createAudit(actionId, 'rejected', actor.trim(), reason.trim(), { platform: current.platform }))
  return rejected
}

export async function simulateControlledAction(actionId: string): Promise<ControlledActionRequest> {
  const current = await getNewMediaRecord<ControlledActionRequest>(ACTION_KIND, actionId)
  if (!current) throw new Error('外发请求不存在')
  if (current.status === 'simulated') return current
  if (current.status !== 'approved') throw new Error('外发请求尚未批准，不能执行')
  const simulated: ControlledActionRequest = { ...current, status: 'simulated', executedAt: Date.now(), simulationReceipt: `simulation:${current.platform}:${current.id}` }
  await persistAction(simulated, createAudit(actionId, 'simulated', 'system:simulation', '已生成模拟平台回执；未发生真实外部发布或消息发送。', {
    platform: current.platform,
    receipt: simulated.simulationReceipt ?? '',
  }))
  return simulated
}

export async function getControlledActionAudit(actionId: string): Promise<ControlledActionAuditEntry[]> {
  const entries = await listNewMediaAudit({ domain: 'governance', subjectId: actionId })
  return entries.map((entry) => ({
    id: entry.id,
    actionId: entry.subjectId,
    event: entry.event as ControlledActionAuditEntry['event'],
    actor: entry.actor,
    createdAt: entry.createdAt,
    detail: entry.detail,
  }))
}

export async function resetControlledActionsForTests(): Promise<void> {
  await clearNewMediaRecordsForTests()
}
