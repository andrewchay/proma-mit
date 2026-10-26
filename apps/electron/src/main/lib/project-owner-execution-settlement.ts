import { readOwnerCommandRuntime } from './project-owner-employee-runtime'
/** Owner命令结算：五类证据+unknown保全+双needs_reconcile；跨链重放键。镜像Pilot语义。 */
import type { PilotUsageEvidence } from './project-pilot-budget-ledger'
import * as store from './project-sqlite-store'
import { requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import { assertPilotRuntimeUsageReceipt } from './project-pilot-budget-ledger'

type OwnerUsageEvidence = PilotUsageEvidence
interface CommandRow { id: string; project_id: string; grant_id: string; source_task_id: string; employee_id: string; reserved_cost_micros: number; actual_cost_micros: number | null; usage_evidence: string | null; usage_record_key: string | null; state: string; execution_id: string | null }
interface GrantRow { id: string; project_id: string; state: string; channel_id: string; model_id: string; max_cost_micros: number }
function usageRecordKey(evidence: OwnerUsageEvidence): string {
  const numericFields = 'costMicros' in evidence
    ? `${evidence.costMicros}:${'inputTokens' in evidence ? evidence.inputTokens : ''}:${'outputTokens' in evidence ? evidence.outputTokens : ''}`
    : ''
  const receiptFields = 'runtimeReceiptId' in evidence || 'payloadHash' in evidence
    ? `${'runtimeReceiptId' in evidence ? evidence.runtimeReceiptId : ''}:${'payloadHash' in evidence ? evidence.payloadHash : ''}`
    : ''
  const basis = evidence.source === 'request_settled'
    ? [...evidence.requestSettlementIds].sort().join(',')
    : `${receiptFields}:${numericFields}`
  return `${evidence.source}:${evidence.executionId}:${evidence.sessionId}:${basis}`
}
/** 跨owner+pilot两链重放键查重：同execution同记录键不得在两链重复结算。 */
function assertNoCrossChainReplay(database: ReturnType<typeof store.getProjectDb>, recordKey: string, executionId: string): void {
  if (database.prepare('SELECT 1 FROM pilot_commands WHERE usage_record_key=? AND execution_id=? LIMIT 1').get(recordKey, executionId)) throw new Error('Owner用量记录键在Pilot账本重复，拒绝结算')
}
export interface OwnerCommandSettlement { commandId: string; state: 'settled' | 'needs_reconcile'; actualCostMicros: number | null; grantNeedsReconcile: boolean }
export function settleOwnerCommandUsage(commandId: string, evidence: OwnerUsageEvidence, now = Date.now(), options: { deferSchedulerWake?: boolean } = {}): OwnerCommandSettlement {
  if (!commandId?.trim() || !Number.isSafeInteger(now) || now < 0) throw new Error('Owner结算参数无效')
  if (evidence.capturedAt > now) throw new Error('Owner用量证据时间无效')
  const actualCostMicros = evidence.source === 'unknown' ? null : evidence.costMicros
  const serializedEvidence = JSON.stringify(evidence)
  const recordKey = usageRecordKey(evidence)
  const database = store.getProjectDb()
  let result: OwnerCommandSettlement | undefined
  let projectId: string | undefined
  database.transaction(() => {
    const command = database.prepare('SELECT * FROM project_owner_execution_commands WHERE id = ?').get(commandId) as CommandRow | undefined
    if (!command || !command.execution_id) throw new Error('Owner命令或执行不存在')
    projectId = command.project_id
    const grant = database.prepare('SELECT * FROM project_owner_execution_grants WHERE id = ? AND project_id = ?').get(command.grant_id, command.project_id) as GrantRow | undefined
    const execution = store.getAgentExecution(command.execution_id)
    if (!grant || !execution || execution.projectId !== command.project_id
      || execution.ownerCommandId !== command.id || execution.entityId !== command.source_task_id
      || execution.entityType !== 'task' || execution.agentId !== command.employee_id
      || !['completed', 'failed', 'cancelled', 'stale'].includes(execution.status)) {
      throw new Error('Owner执行未终结或账本归属无法核验')
    }
    const runtime = readOwnerCommandRuntime(command.id)
    if (execution.id !== evidence.executionId || execution.sessionId !== evidence.sessionId
      || runtime.channelId !== evidence.channelId || runtime.modelId !== evidence.modelId) {
      throw new Error('Owner用量证据与执行、会话、渠道或模型不匹配')
    }
    if (evidence.source === 'runtime_reported' || evidence.source === 'unknown') assertPilotRuntimeUsageReceipt(evidence, command.project_id)
    if (evidence.source === 'request_settled') {
      const rows = database.prepare('SELECT request_id, state, settled_cost_micros FROM project_owner_execution_request_reservations WHERE command_id = ?').all(commandId) as Array<{ request_id: string; state: string; settled_cost_micros: number | null }>
      if (rows.length < 1) throw new Error('Owner命令没有逐请求结算记录')
      const dbIds = rows.map(row => row.request_id).sort()
      const evidenceIds = [...evidence.requestSettlementIds].sort()
      if (dbIds.length !== evidenceIds.length || dbIds.some((id, index) => id !== evidenceIds[index])) throw new Error('Owner逐请求结算清单与命令预留不一致')
      if (rows.some(row => row.state !== 'settled')) throw new Error('Owner命令仍有未结算的请求预留')
      if (rows.reduce((sum, row) => sum + (row.settled_cost_micros ?? 0), 0) !== evidence.costMicros) throw new Error('Owner逐请求结算总额不一致')
    }
    // open escalation期间拒绝非unknown结算：unknown按全额预留占额保留。
    const openEscalation = database.prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL LIMIT 1').get(commandId)
    if (openEscalation && evidence.source !== 'unknown') throw new Error('Owner停止升级待人工对账，拒绝非unknown结算')
    assertNoCrossChainReplay(database, recordKey, execution.id)
    if ((command.state === 'settled' || command.state === 'needs_reconcile')
      && command.actual_cost_micros === actualCostMicros && command.usage_evidence === serializedEvidence
      && command.usage_record_key === recordKey) {
      result = { commandId, state: command.state as 'settled' | 'needs_reconcile', actualCostMicros, grantNeedsReconcile: grant.state === 'needs_reconcile' }
      return
    }
    if (!['queued', 'running', 'needs_reconcile'].includes(command.state)) throw new Error('Owner命令状态不可结算')
    const reserved = command.reserved_cost_micros
    const overReserved = actualCostMicros !== null && actualCostMicros > reserved
    const nextState = overReserved || actualCostMicros === null ? 'needs_reconcile' : 'settled'
    const updated = database.prepare(`UPDATE project_owner_execution_commands SET state = ?, actual_cost_micros = ?, usage_evidence = ?, usage_record_key = ?, updated_at = ?
      WHERE id = ? AND state IN ('queued','running','needs_reconcile')`).run(nextState, actualCostMicros, serializedEvidence, recordKey, now, commandId)
    if (updated.changes !== 1) throw new Error('Owner命令结算状态已变化')
    let grantNeedsReconcile = grant.state === 'needs_reconcile'
    if (nextState === 'needs_reconcile' && grant.state === 'active') {
      const paused = database.prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile' WHERE id=? AND state='active'").run(grant.id)
      if (paused.changes !== 1) throw new Error('Owner授权对账状态写入失败')
      grantNeedsReconcile = true
    }
    result = { commandId, state: nextState, actualCostMicros, grantNeedsReconcile }
  })()
  if (!result) throw new Error('Owner结算未完成')
  if (projectId && !options.deferSchedulerWake) requestOwnerAutonomousScheduleWake(projectId)
  return result
}
/** 只读占额：与预算核验同口径（settled实结、其余含unknown按预留）。 */
export function readOwnerGrantUsage(grantId: string): { runReservations: number; committedCostMicros: number } {
  if (!grantId?.trim()) throw new Error('Owner授权参数无效')
  const row = store.getProjectDb().prepare(`SELECT COALESCE(SUM(CASE WHEN state = 'released' THEN 0 ELSE 1 END), 0) AS runs,
    COALESCE(SUM(CASE WHEN state = 'released' THEN 0 WHEN state = 'settled' AND actual_cost_micros IS NOT NULL THEN actual_cost_micros WHEN actual_cost_micros > reserved_cost_micros THEN actual_cost_micros ELSE reserved_cost_micros END), 0) AS committed
    FROM project_owner_execution_commands WHERE grant_id = ?`).get(grantId) as { runs: number; committed: number }
  if (!Number.isSafeInteger(row.runs) || !Number.isSafeInteger(row.committed) || row.committed < 0) throw new Error('Owner预算账本无法核验')
  return { runReservations: row.runs, committedCostMicros: row.committed }
}
