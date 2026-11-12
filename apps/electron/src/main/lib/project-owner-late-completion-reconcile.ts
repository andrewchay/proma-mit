/** 迟到终态的第一阶段：追加原始账本证据并核对费用；授权保持暂停。 */
import { readOwnerCommandRuntime } from './project-owner-employee-runtime'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { assertOwnerLateCompletionPreviewCurrent, previewOwnerLateCompletion } from './project-owner-late-completion-preview'
import { settleOwnerCommandUsage } from './project-owner-execution-settlement'
import * as store from './project-sqlite-store'

export interface OwnerLateCompletionReconciliation {
  commandId: string
  executionId: string
  projectId: string
  grantId: string
  taskId: string
  originalCommand: { state: string; usageEvidence: string; usageRecordKey: string; actualCostMicros: number | null; reservedCostMicros: number }
  originalExecution: { status: string; error: string | null; resultSummary: string | null; completedAt: number | null; lastHeartbeatAt: number | null }
  previewFingerprint: string
  snapshotHash: string
  terminalHash: string
  assistantSummaryHash: string
  requestSettlementIds: string[]
  costMicros: number
  createdAt: number
}

/** 从不可修改的对账记录读取完整原状态；摘要或身份不符时拒绝后续恢复。 */
export function readOwnerLateCompletionReconciliation(commandId: string): OwnerLateCompletionReconciliation | null {
  const row = store.getProjectDb().prepare('SELECT execution_id,project_id,grant_id,payload,integrity_hash,created_at FROM project_owner_late_completion_reconciliations WHERE command_id=?').get(commandId) as {
    execution_id: string; project_id: string; grant_id: string; payload: string; integrity_hash: string; created_at: number
  } | undefined
  if (!row) return null
  let value: OwnerLateCompletionReconciliation
  try { value = JSON.parse(row.payload) as OwnerLateCompletionReconciliation } catch { throw new Error('迟到终态对账记录无法解析') }
  if (!value || value.commandId !== commandId || value.executionId !== row.execution_id || value.projectId !== row.project_id
    || value.grantId !== row.grant_id || value.createdAt !== row.created_at || ownerExecutionHash(value) !== row.integrity_hash
    || value.originalCommand?.state !== 'needs_reconcile' || value.originalCommand.actualCostMicros !== null
    || value.originalExecution?.status !== 'stale' || !Number.isSafeInteger(value.costMicros) || value.costMicros < 0
    || !Array.isArray(value.requestSettlementIds) || !value.requestSettlementIds.length) throw new Error('迟到终态对账记录身份或完整性无效')
  return value
}

/** 不启动模型、验证或派工；未知费用与失联状态原文在同一事务中先保存。 */
export async function reconcileOwnerLateCompletion(commandId: string, expectedFingerprint: string, isSessionActive: (sessionId: string) => boolean): Promise<OwnerLateCompletionReconciliation> {
  const preview = await previewOwnerLateCompletion(commandId, isSessionActive)
  if (!preview || preview.fingerprint !== expectedFingerprint) throw new Error('迟到终态预览已失效，保留原账本')
  const db = store.getProjectDb()
  let result: OwnerLateCompletionReconciliation | undefined
  db.transaction(() => {
    assertOwnerLateCompletionPreviewCurrent(preview, isSessionActive)
    const c = db.prepare('SELECT state,usage_evidence,usage_record_key,actual_cost_micros,reserved_cost_micros,execution_id FROM project_owner_execution_commands WHERE id=?').get(commandId) as {
      state: string; usage_evidence: string; usage_record_key: string; actual_cost_micros: number | null; reserved_cost_micros: number; execution_id: string
    }
    const e = db.prepare('SELECT status,error,result_summary,completed_at,last_heartbeat_at,session_id FROM agent_executions WHERE id=? AND owner_command_id=?').get(c.execution_id, commandId) as {
      status: string; error: string | null; result_summary: string | null; completed_at: number | null; last_heartbeat_at: number | null; session_id: string
    }
    if (db.prepare('SELECT 1 FROM project_owner_late_completion_reconciliations WHERE command_id=?').get(commandId)) throw new Error('迟到终态已有对账记录，拒绝重复写入')
    const now = Date.now()
    result = { commandId, executionId: c.execution_id, projectId: preview.projectId, grantId: preview.grantId, taskId: preview.taskId,
      originalCommand: { state: c.state, usageEvidence: c.usage_evidence, usageRecordKey: c.usage_record_key, actualCostMicros: c.actual_cost_micros, reservedCostMicros: c.reserved_cost_micros },
      originalExecution: { status: e.status, error: e.error, resultSummary: e.result_summary, completedAt: e.completed_at, lastHeartbeatAt: e.last_heartbeat_at },
      previewFingerprint: preview.fingerprint, snapshotHash: preview.snapshotHash, terminalHash: preview.evidence.terminalHash,
      assistantSummaryHash: preview.evidence.assistantSummaryHash, requestSettlementIds: preview.evidence.requestSettlementIds,
      costMicros: preview.evidence.costMicros, createdAt: now }
    db.prepare('INSERT INTO project_owner_late_completion_reconciliations (command_id,execution_id,project_id,grant_id,payload,integrity_hash,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(commandId, c.execution_id, preview.projectId, preview.grantId, JSON.stringify(result), ownerExecutionHash(result), now)
    const updated = db.prepare("UPDATE agent_executions SET status='completed',result_summary=?,error='',completed_at=? WHERE id=? AND owner_command_id=? AND session_id=? AND status='stale'")
      .run(preview.evidence.assistantSummary, now, c.execution_id, commandId, e.session_id)
    if (updated.changes !== 1) throw new Error('迟到终态执行状态已变化，事务回滚')
    const runtime = readOwnerCommandRuntime(commandId)
    const settled = settleOwnerCommandUsage(commandId, { source: 'request_settled', executionId: c.execution_id, sessionId: e.session_id,
      channelId: runtime.channelId, modelId: runtime.modelId, capturedAt: now,
      requestSettlementIds: preview.evidence.requestSettlementIds, costMicros: preview.evidence.costMicros }, now, { deferSchedulerWake: true })
    if (settled.state !== 'settled') throw new Error('迟到终态费用未能准确结算，事务回滚')
    store.recordProjectActivity({ projectId: preview.projectId, entityType: 'task', entityId: preview.taskId,
      action: 'owner_late_completion_reconciled', actor: 'system:owner-runtime', summary: '迟到终态与已结算请求已核对；原失联与未知费用记录保留，授权仍暂停等待成果验证。',
      payload: { commandId, executionId: c.execution_id, snapshotHash: preview.snapshotHash, costMicros: preview.evidence.costMicros } })
  })()
  if (!result) throw new Error('迟到终态对账事务未完成')
  return result
}
