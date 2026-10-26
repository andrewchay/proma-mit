/** 过期 Owner unknown grant 的只读预览与审计归档；不结算、不清零、不释放 command 占额。 */
import { createHash } from 'node:crypto'
import * as store from './project-sqlite-store'

interface ArchiveInput {
  projectId: string
  grantId: string
  runId: string
  receiptSha256: string
}
interface ArchiveCommandSnapshot {
  id: string
  state: string
  reservedCostMicros: number
  actualCostMicros: number | null
  executionId: string | null
  executionStatus: string | null
}
interface ArchiveRequestSnapshot {
  requestId: string
  state: string
  settledCostMicros: number | null
}
interface ArchiveStartAttemptSnapshot {
  executionId: string
  commandId: string
  sessionId: string
  claimedAt: number
  handoffIntentAt: number | null
}
interface ArchiveStartReceiptSnapshot {
  executionId: string
  commandId: string
  runnerName: string
  startedAt: number
  receivedAt: number
}
interface ArchiveSnapshot {
  grantId: string
  projectId: string
  grantState: string
  expiresAt: number
  maxCostMicros: number
  commands: ArchiveCommandSnapshot[]
  requests: ArchiveRequestSnapshot[]
  startAttempts: ArchiveStartAttemptSnapshot[]
  startReceipts: ArchiveStartReceiptSnapshot[]
  reservedCostMicros: number
  actualCostMicros: number | null
  unknownCommandCount: number
}
export interface ExpiredOwnerGrantArchivePreview extends ArchiveSnapshot {
  runId: string
  receiptSha256: string
  budgetReleasedMicros: 0
  fingerprint: string
}
export interface ExpiredOwnerGrantArchiveResult {
  grantId: string
  projectId: string
  state: 'archived'
  fingerprint: string
  alreadyArchived: boolean
  reservedCostMicros: number
  actualCostMicros: number | null
  budgetReleasedMicros: 0
}

function assertInput(input: ArchiveInput): void {
  if (typeof input.projectId !== 'string' || !input.projectId.trim() || input.projectId.length > 200
    || typeof input.grantId !== 'string' || !input.grantId.trim() || input.grantId.length > 200
    || typeof input.runId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.runId)
    || typeof input.receiptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.receiptSha256)) {
    throw new Error('Owner过期归档输入无效')
  }
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function readSnapshot(input: ArchiveInput, now: number): ArchiveSnapshot {
  const database = store.getProjectDb()
  const grant = database.prepare(`SELECT id, project_id, state, expires_at, max_cost_micros
    FROM project_owner_execution_grants WHERE id=? AND project_id=?`).get(input.grantId, input.projectId) as {
      id: string; project_id: string; state: string; expires_at: number; max_cost_micros: number
    } | undefined
  if (!grant) throw new Error('Owner授权不存在或不属于指定项目')
  if (grant.state !== 'needs_reconcile') throw new Error('仅needs_reconcile授权可走过期归档')
  if (!Number.isSafeInteger(grant.expires_at) || grant.expires_at > now) throw new Error('Owner授权尚未过期，拒绝归档')

  const commands = database.prepare(`SELECT c.id, c.state, c.reserved_cost_micros, c.actual_cost_micros, c.execution_id,
      e.status AS execution_status
    FROM project_owner_execution_commands c LEFT JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.grant_id=? AND c.project_id=? ORDER BY c.id`).all(input.grantId, input.projectId) as Array<{
      id: string; state: string; reserved_cost_micros: number; actual_cost_micros: number | null; execution_id: string | null; execution_status: string | null
    }>
  if (commands.length === 0) throw new Error('Owner授权没有可归档的命令账本')
  if (commands.some(command => ['reserved', 'queued', 'running'].includes(command.state)
    || command.execution_status === 'queued' || command.execution_status === 'running')) {
    throw new Error('Owner仍有运行或排队中的命令/执行，拒绝归档')
  }

  const commandIds = commands.map(command => command.id)
  const requests: ArchiveRequestSnapshot[] = commandIds.length === 0 ? [] : database.prepare(`SELECT request_id, state, settled_cost_micros
    FROM project_owner_execution_request_reservations WHERE command_id IN (${commandIds.map(() => '?').join(',')}) ORDER BY request_id`).all(...commandIds).map(row => {
      const item = row as { request_id: string; state: string; settled_cost_micros: number | null }
      return { requestId: item.request_id, state: item.state, settledCostMicros: item.settled_cost_micros }
    })
  if (requests.some(request => request.state === 'reserved')) throw new Error('仍有未收敛的请求预留，拒绝归档')
  const openStops = database.prepare(`SELECT escalation_id FROM project_owner_execution_stop_escalations
    WHERE project_id=? AND command_id IN (${commandIds.map(() => '?').join(',')}) AND resolved_at IS NULL LIMIT 1`).get(input.projectId, ...commandIds)
  if (openStops) throw new Error('仍有未解决的停止升级，拒绝归档')

  const startAttempts = database.prepare(`SELECT execution_id, command_id, session_id, claimed_at, handoff_intent_at
    FROM project_owner_execution_start_attempts WHERE command_id IN (${commandIds.map(() => '?').join(',')}) ORDER BY command_id`).all(...commandIds).map(row => {
      const item = row as { execution_id: string; command_id: string; session_id: string; claimed_at: number; handoff_intent_at: number | null }
      return { executionId: item.execution_id, commandId: item.command_id, sessionId: item.session_id, claimedAt: item.claimed_at, handoffIntentAt: item.handoff_intent_at }
    })
  const startReceipts = database.prepare(`SELECT execution_id, command_id, runner_name, started_at, received_at
    FROM project_owner_execution_start_receipts WHERE command_id IN (${commandIds.map(() => '?').join(',')}) ORDER BY command_id`).all(...commandIds).map(row => {
      const item = row as { execution_id: string; command_id: string; runner_name: string; started_at: number; received_at: number }
      return { executionId: item.execution_id, commandId: item.command_id, runnerName: item.runner_name, startedAt: item.started_at, receivedAt: item.received_at }
    })
  const commandSnapshots = commands.map(command => ({
    id: command.id,
    state: command.state,
    reservedCostMicros: command.reserved_cost_micros,
    actualCostMicros: command.actual_cost_micros,
    executionId: command.execution_id,
    executionStatus: command.execution_status,
  }))
  const unknownCommandCount = commands.filter(command => command.state === 'needs_reconcile' || command.actual_cost_micros === null).length
  const actualCostMicros = unknownCommandCount > 0
    ? null
    : commands.reduce((sum, command) => sum + (command.actual_cost_micros ?? 0), 0)
  return {
    grantId: grant.id,
    projectId: grant.project_id,
    grantState: grant.state,
    expiresAt: grant.expires_at,
    maxCostMicros: grant.max_cost_micros,
    commands: commandSnapshots,
    requests,
    startAttempts,
    startReceipts,
    reservedCostMicros: commands.filter(command => command.state !== 'released').reduce((sum, command) => sum + command.reserved_cost_micros, 0),
    actualCostMicros,
    unknownCommandCount,
  }
}
function archiveFingerprint(snapshot: ArchiveSnapshot, input: ArchiveInput): string {
  return hash({
    action: 'expired_grant_archive',
    snapshot,
    runId: input.runId,
    receiptSha256: input.receiptSha256,
    budgetReleasedMicros: 0,
  })
}
function makePreview(input: ArchiveInput, snapshot: ArchiveSnapshot): ExpiredOwnerGrantArchivePreview {
  return {
    ...snapshot,
    runId: input.runId,
    receiptSha256: input.receiptSha256,
    budgetReleasedMicros: 0,
    fingerprint: archiveFingerprint(snapshot, input),
  }
}
export function previewExpiredOwnerExecutionGrantArchive(input: ArchiveInput): ExpiredOwnerGrantArchivePreview {
  assertInput(input)
  return makePreview(input, readSnapshot(input, Date.now()))
}
export function confirmExpiredOwnerExecutionGrantArchive(input: ArchiveInput & { expectedFingerprint: string }): ExpiredOwnerGrantArchiveResult {
  assertInput(input)
  if (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) throw new Error('Owner归档指纹无效')
  const now = Date.now()
  const database = store.getProjectDb()
  if (database.isTransactionActive()) throw new Error('拒绝未提交外层事务')
  let result: ExpiredOwnerGrantArchiveResult | undefined
  database.transaction(() => {
    const grant = database.prepare('SELECT state FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(input.grantId, input.projectId) as { state: string } | undefined
    if (!grant) throw new Error('Owner授权不存在或不属于指定项目')
    if (grant.state === 'archived') {
      const decision = database.prepare(`SELECT fingerprint, impact FROM project_owner_execution_grant_decisions
        WHERE grant_id=? AND project_id=? AND action='reconcile' ORDER BY created_at DESC LIMIT 1`).get(input.grantId, input.projectId) as { fingerprint: string; impact: string } | undefined
      if (!decision || decision.fingerprint !== input.expectedFingerprint) throw new Error('Owner归档已完成，但指纹与既有审计不匹配')
      const impact = JSON.parse(decision.impact) as {
        reason: string; runId: string; receiptSha256: string; reservedCostMicros: number
        actualCostMicros: number | null; budgetReleasedMicros: 0
      }
      if (impact.reason !== 'expired_grant_archive' || impact.runId !== input.runId
        || impact.receiptSha256 !== input.receiptSha256 || impact.budgetReleasedMicros !== 0) {
        throw new Error('Owner归档已完成，但重放证据与既有审计不匹配')
      }
      result = { grantId: input.grantId, projectId: input.projectId, state: 'archived', fingerprint: decision.fingerprint, alreadyArchived: true, reservedCostMicros: impact.reservedCostMicros, actualCostMicros: impact.actualCostMicros, budgetReleasedMicros: 0 }
      return
    }
    const snapshot = readSnapshot(input, now)
    const fingerprint = archiveFingerprint(snapshot, input)
    if (fingerprint !== input.expectedFingerprint) throw new Error('Owner归档影响面或证据已变化，请重新预览')
    const impact = {
      reason: 'expired_grant_archive',
      evidenceKind: 'local_fake_only_harness_receipt_not_provider_bill',
      runId: input.runId,
      receiptSha256: input.receiptSha256,
      grantExpiresAt: snapshot.expiresAt,
      commands: snapshot.commands,
      requests: snapshot.requests,
      startAttempts: snapshot.startAttempts,
      startReceipts: snapshot.startReceipts,
      reservedCostMicros: snapshot.reservedCostMicros,
      actualCostMicros: snapshot.actualCostMicros,
      unknownCommandCount: snapshot.unknownCommandCount,
      budgetReleasedMicros: 0 as const,
    }
    const updated = database.prepare(`UPDATE project_owner_execution_grants SET state='archived'
      WHERE id=? AND project_id=? AND state='needs_reconcile' AND expires_at<=?`).run(input.grantId, input.projectId, now)
    if (updated.changes !== 1) throw new Error('Owner授权状态或期限已变化，归档已拒绝')
    database.prepare(`INSERT INTO project_owner_execution_grant_decisions
      (grant_id,project_id,action,fingerprint,impact,actor,created_at) VALUES(?,?,'reconcile',?,?,?,?)`)
      .run(input.grantId, input.projectId, fingerprint, JSON.stringify(impact), 'local-user', now)
    result = { grantId: input.grantId, projectId: input.projectId, state: 'archived', fingerprint, alreadyArchived: false, reservedCostMicros: snapshot.reservedCostMicros, actualCostMicros: snapshot.actualCostMicros, budgetReleasedMicros: 0 }
  })()
  if (!result) throw new Error('Owner过期归档事务未提交')
  return result
}
