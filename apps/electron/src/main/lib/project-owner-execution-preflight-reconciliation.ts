/** Owner发送前失败对账：仅操作人确认的本地审计，不构造Provider用量回执。 */
import { createHash, randomUUID } from 'node:crypto'
import type { ProviderType, ProjectOwnerGoalSubject } from '@gravitas/shared'
import { getAgentProviderProtocol } from '@gravitas/shared'
import { getChannelById } from './channel-manager'
import { getPilotReviewedPriceEvidence } from './project-pilot-request-evidence'
import { PILOT_DEFAULT_PRICE_EVIDENCE_ID } from './project-pilot-request-exit'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { ownerExecutionHash, ownerExecutionObject, parseOwnerExecutionSubject } from './project-owner-execution-source'
import { requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import * as store from './project-sqlite-store'

const LEGACY_PRICE_REJECTION = 'Owner 命令输出上限与运行授权/审核价格证据不匹配'
const LEGACY_ZHIPU_MODEL = 'glm-5.3-flash'
interface OwnerPreflightCandidate {
  command_id: string
  project_id: string
  grant_id: string
  channel_id: string
  model_id: string
  runtime: string
  command_state: string
  execution_id: string | null
  reserved_cost_micros: number
  actual_cost_micros: number | null
  usage_evidence: string | null
  usage_record_key: string | null
  command_updated_at: number
  grant_state: string
  grant_channel_id: string
  grant_model_id: string
  grant_runtime: string
}
interface PreflightRejectionRow {
  execution_id: string
  command_id: string
  project_id: string
  grant_id: string
  channel_id: string
  model_id: string
  provider_type: string
  provider_protocol: string
  price_evidence_id: string
  reason_code: string
  error_sha256: string
}
interface PriorUsageMarker {
  kind: 'none' | 'runtime_unknown'
  evidenceSha256: string | null
  recordKeySha256: string | null
  evidence: string | null
  recordKey: string | null
}
function readPriorUsageMarker(row: Pick<OwnerPreflightCandidate, 'usage_evidence' | 'usage_record_key' | 'channel_id' | 'model_id'>, executionId: string, sessionId: string): PriorUsageMarker {
  if (row.usage_evidence === null && row.usage_record_key === null) return { kind: 'none', evidenceSha256: null, recordKeySha256: null, evidence: null, recordKey: null }
  const expectedRecordKey = `unknown:${executionId}:${sessionId}::`
  if (row.usage_evidence === null || row.usage_record_key !== expectedRecordKey) throw new Error('Owner命令既有usage标记不是可核验的Runtime unknown形状')
  let parsed: unknown
  try { parsed = JSON.parse(row.usage_evidence) as unknown } catch { throw new Error('Owner命令Runtime unknown标记无法解析') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Owner命令Runtime unknown标记结构无效')
  const evidence = parsed as Record<string, unknown>
  const expectedKeys = ['source', 'executionId', 'sessionId', 'channelId', 'modelId', 'capturedAt', 'reason'].sort()
  if (Object.keys(evidence).sort().join('|') !== expectedKeys.join('|') || evidence.source !== 'unknown'
    || evidence.executionId !== executionId || evidence.sessionId !== sessionId || evidence.channelId !== row.channel_id
    || evidence.modelId !== row.model_id || !Number.isSafeInteger(evidence.capturedAt) || (evidence.capturedAt as number) < 0
    || evidence.reason !== 'Runtime终态缺少完整逐请求用量结算') {
    throw new Error('Owner命令既有usage标记与Runtime终态不匹配')
  }
  return { kind: 'runtime_unknown', evidenceSha256: errorHash(row.usage_evidence), recordKeySha256: errorHash(row.usage_record_key), evidence: row.usage_evidence, recordKey: row.usage_record_key }
}
export interface OwnerPreflightReconciliationPreview extends ProjectOwnerGoalSubject {
  commandId: string
  grantId: string
  executionId: string
  channelId: string
  modelId: string
  provider: ProviderType
  evidenceKind: 'typed_preflight' | 'legacy_operator_attested'
  reasonCode: string
  errorMessage: string
  errorSha256: string
  reservedCostMicros: number
  requestReservationCount: 0
  preReconciliationUsageMarker: 'none' | 'runtime_unknown'
  preReconciliationUsageEvidenceSha256: string | null
  preReconciliationUsageRecordKeySha256: string | null
  runReservationsReleased: 1
  grantWillPause: true
  providerConsoleAttestationRequired: true
  fingerprint: string
}
export interface OwnerPreflightReconciliationResult {
  commandId: string
  reconciliationId: string
  state: 'released'
  actualCostMicros: 0
  grantState: 'paused'
  evidenceKind: 'typed_preflight' | 'legacy_operator_attested'
  alreadyApplied: boolean
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Owner发送前对账${label}无效`)
  return value.trim()
}
function errorHash(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex')
}
function providerKindFor(provider: ProviderType): 'openai' | 'anthropic' | 'google' {
  const protocol = getAgentProviderProtocol(provider, 'ai-sdk')
  return protocol === 'openai-chat' ? 'openai' : protocol === 'anthropic-messages' ? 'anthropic' : 'google'
}
function readCandidate(subject: ProjectOwnerGoalSubject, commandId: string): OwnerPreflightReconciliationPreview {
  const database = store.getProjectDb()
  const row = database.prepare(`SELECT c.id AS command_id, c.project_id, c.grant_id, c.execution_id,
      c.reserved_cost_micros, c.actual_cost_micros, c.usage_evidence, c.usage_record_key,
      c.updated_at AS command_updated_at, c.state AS command_state,
      g.state AS grant_state, g.channel_id AS grant_channel_id, g.model_id AS grant_model_id, g.runtime AS grant_runtime,
      g.channel_id, g.model_id, g.runtime
    FROM project_owner_execution_commands c
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE c.id=? AND c.project_id=? AND (? IS NULL OR c.source_task_id=?)`).get(commandId, subject.projectId, subject.taskId ?? null, subject.taskId ?? null) as OwnerPreflightCandidate | undefined
  if (!row || !row.execution_id || row.command_state !== 'needs_reconcile' || row.grant_state !== 'needs_reconcile'
    || row.actual_cost_micros !== null || !Number.isSafeInteger(row.reserved_cost_micros) || row.reserved_cost_micros <= 0
    || row.grant_channel_id !== row.channel_id || row.grant_model_id !== row.model_id || row.grant_runtime !== 'ai-sdk' || row.runtime !== 'ai-sdk') {
    throw new Error('Owner命令或授权不符合发送前失败对账条件，继续保留needs_reconcile占额')
  }
  const execution = store.getAgentExecution(row.execution_id)
  if (!execution || execution.status !== 'failed' || execution.ownerCommandId !== row.command_id
    || execution.projectId !== row.project_id || execution.entityType !== 'task' || !execution.sessionId.trim()
    || execution.error !== LEGACY_PRICE_REJECTION) {
    throw new Error('Owner执行未以已知发送前拒绝终结，不能释放占额')
  }
  const priorUsageMarker = readPriorUsageMarker(row, execution.id, execution.sessionId)
  const attempt = database.prepare(`SELECT session_id, handoff_intent_at FROM project_owner_execution_start_attempts
    WHERE execution_id=? AND command_id=? AND project_id=?`).get(execution.id, row.command_id, row.project_id) as { session_id: string; handoff_intent_at: number | null } | undefined
  if (!attempt || attempt.session_id !== execution.sessionId || attempt.handoff_intent_at === null) {
    throw new Error('Owner Runtime交接记录无法核验，不能释放占额')
  }
  const requestCount = database.prepare(`SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations
    WHERE command_id=? OR execution_id=?`).get(row.command_id, execution.id) as { count: number }
  if (requestCount.count !== 0) throw new Error('Owner命令已有逐请求账本记录，不能按发送前失败释放')
  if (database.prepare(`SELECT 1 FROM project_owner_execution_stop_escalations
    WHERE command_id=? AND resolved_at IS NULL LIMIT 1`).get(row.command_id)) {
    throw new Error('Owner停止升级尚未解决，不能执行发送前失败对账')
  }
  if (database.prepare(`SELECT 1 FROM project_owner_execution_preflight_reconciliations
    WHERE command_id=? OR execution_id=? LIMIT 1`).get(row.command_id, execution.id)) {
    throw new Error('Owner发送前失败已对账，不得重复创建预览')
  }

  const channel = getChannelById(row.channel_id)
  if (!channel) throw new Error('Owner冻结渠道不存在，不能核验发送前拒绝')
  const currentErrorHash = errorHash(execution.error)
  const rejection = database.prepare(`SELECT execution_id, command_id, project_id, grant_id, channel_id, model_id,
      provider_type, provider_protocol, price_evidence_id, reason_code, error_sha256
    FROM project_owner_execution_preflight_rejections WHERE execution_id=? OR command_id=?`).get(execution.id, row.command_id) as PreflightRejectionRow | undefined
  let evidenceKind: OwnerPreflightReconciliationPreview['evidenceKind']
  let reasonCode: string
  if (rejection) {
    const protocol = getAgentProviderProtocol(channel.provider, 'ai-sdk')
    if (rejection.execution_id !== execution.id || rejection.command_id !== row.command_id || rejection.project_id !== row.project_id
      || rejection.grant_id !== row.grant_id || rejection.channel_id !== row.channel_id || rejection.model_id !== row.model_id
      || rejection.provider_type !== channel.provider || rejection.provider_protocol !== protocol
      || rejection.price_evidence_id !== PILOT_DEFAULT_PRICE_EVIDENCE_ID
      || rejection.reason_code !== 'reviewed_price_evidence_mismatch' || rejection.error_sha256 !== currentErrorHash) {
      throw new Error('Owner类型化预发送拒绝证据与当前执行不一致，保留needs_reconcile')
    }
    evidenceKind = 'typed_preflight'
    reasonCode = rejection.reason_code
  } else {
    const protocol = getAgentProviderProtocol(channel.provider, 'ai-sdk')
    const price = getPilotReviewedPriceEvidence(PILOT_DEFAULT_PRICE_EVIDENCE_ID)
    if (channel.provider !== 'zhipu' || row.model_id !== LEGACY_ZHIPU_MODEL || protocol !== 'openai-chat'
      || !price || price.model !== row.model_id || price.providerKind !== providerKindFor(channel.provider)) {
      throw new Error('缺少可核验的发送前拒绝事件，且不属于已知旧版Zhipu协议映射回归；保留needs_reconcile')
    }
    evidenceKind = 'legacy_operator_attested'
    reasonCode = 'legacy_zhipu_protocol_mapping_before_fetch'
  }
  const fingerprint = ownerExecutionHash({
    projectId: subject.projectId, taskId: subject.taskId ?? null, commandId: row.command_id, grantId: row.grant_id, executionId: execution.id,
    channelId: row.channel_id, modelId: row.model_id, evidenceKind, reasonCode, errorSha256: currentErrorHash,
    reservedCostMicros: row.reserved_cost_micros, requestReservationCount: 0,
    commandUpdatedAt: row.command_updated_at, executionStatus: execution.status, executionSessionId: execution.sessionId,
    handoffIntentAt: attempt.handoff_intent_at, grantState: row.grant_state,
    preReconciliationUsageMarker: priorUsageMarker.kind, preReconciliationUsageEvidenceSha256: priorUsageMarker.evidenceSha256,
    preReconciliationUsageRecordKeySha256: priorUsageMarker.recordKeySha256,
  })
  return {
    projectId: subject.projectId, ...(subject.taskId === undefined ? {} : { taskId: subject.taskId }),
    commandId: row.command_id, grantId: row.grant_id, executionId: execution.id,
    channelId: row.channel_id, modelId: row.model_id, provider: channel.provider,
    evidenceKind, reasonCode, errorMessage: execution.error, errorSha256: currentErrorHash,
    reservedCostMicros: row.reserved_cost_micros, requestReservationCount: 0,
    preReconciliationUsageMarker: priorUsageMarker.kind,
    preReconciliationUsageEvidenceSha256: priorUsageMarker.evidenceSha256,
    preReconciliationUsageRecordKeySha256: priorUsageMarker.recordKeySha256,
    runReservationsReleased: 1, grantWillPause: true, providerConsoleAttestationRequired: true, fingerprint,
  }
}

export function previewOwnerPreflightReconciliation(rawSubject: unknown, rawRequest: unknown): OwnerPreflightReconciliationPreview {
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject)
  const request = ownerExecutionObject(rawRequest, ['commandId'])
  return readCandidate(subject, text(request.commandId, '命令ID'))
}

export function confirmOwnerPreflightReconciliation(rawSubject: unknown, rawRequest: unknown, now = Date.now()): OwnerPreflightReconciliationResult {
  assertLocalActorEnabled()
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner发送前对账时钟无效')
  const subject = parseOwnerExecutionSubject(rawSubject)
  const request = ownerExecutionObject(rawRequest, ['commandId', 'confirmedFingerprint', 'providerConsoleCheckedNoUsage'])
  const commandId = text(request.commandId, '命令ID')
  const confirmedFingerprint = text(request.confirmedFingerprint, '确认指纹')
  if (!/^[a-f0-9]{64}$/.test(confirmedFingerprint)) throw new Error('Owner发送前对账确认指纹无效')
  if (request.providerConsoleCheckedNoUsage !== true) throw new Error('请先核对对应Provider控制台，并明确确认没有此请求或用量')
  const database = store.getProjectDb()
  if (database.isTransactionActive()) throw new Error('Owner发送前对账不得嵌套未提交事务')
  let result: OwnerPreflightReconciliationResult | undefined
  let projectId: string | undefined
  database.transaction(() => {
    assertLocalActorEnabled()
    const previous = database.prepare(`SELECT reconciliation_id, project_id, execution_id, grant_id, evidence_kind, confirmed_fingerprint,
        pre_reconciliation_usage_marker, pre_reconciliation_usage_evidence_sha256, pre_reconciliation_usage_record_key_sha256
      FROM project_owner_execution_preflight_reconciliations WHERE command_id=?`).get(commandId) as {
        reconciliation_id: string; project_id: string; execution_id: string; grant_id: string; evidence_kind: OwnerPreflightReconciliationPreview['evidenceKind']; confirmed_fingerprint: string
        pre_reconciliation_usage_marker: 'none' | 'runtime_unknown'; pre_reconciliation_usage_evidence_sha256: string | null; pre_reconciliation_usage_record_key_sha256: string | null
      } | undefined
    if (previous) {
      if (previous.project_id !== subject.projectId || previous.confirmed_fingerprint !== confirmedFingerprint) {
        throw new Error('Owner发送前对账已有不同确认记录，拒绝重放')
      }
      const current = database.prepare(`SELECT c.state AS command_state, c.actual_cost_micros, c.usage_evidence,
          c.usage_record_key, g.state AS grant_state, c.execution_id
        FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
        WHERE c.id=? AND c.project_id=? AND g.id=?`).get(commandId, subject.projectId, previous.grant_id) as {
          command_state: string; actual_cost_micros: number | null; usage_evidence: string | null; usage_record_key: string | null; grant_state: string; execution_id: string | null
        } | undefined
      const requestCount = database.prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE command_id=? OR execution_id=?').get(commandId, previous.execution_id) as { count: number }
      const openEscalation = database.prepare('SELECT 1 FROM project_owner_execution_stop_escalations WHERE command_id=? AND resolved_at IS NULL LIMIT 1').get(commandId)
      const previousAuditValid = previous.pre_reconciliation_usage_marker === 'none'
        ? previous.pre_reconciliation_usage_evidence_sha256 === null && previous.pre_reconciliation_usage_record_key_sha256 === null
        : previous.pre_reconciliation_usage_marker === 'runtime_unknown'
          && /^[a-f0-9]{64}$/.test(previous.pre_reconciliation_usage_evidence_sha256 ?? '')
          && /^[a-f0-9]{64}$/.test(previous.pre_reconciliation_usage_record_key_sha256 ?? '')
      if (!current || current.command_state !== 'released' || current.actual_cost_micros !== 0 || current.usage_evidence !== null
        || current.usage_record_key !== null || current.grant_state !== 'paused' || current.execution_id !== previous.execution_id
        || !previousAuditValid || requestCount.count !== 0 || openEscalation) throw new Error('Owner已对账账本状态出现变化，拒绝按历史确认重放')
      result = { commandId, reconciliationId: previous.reconciliation_id, state: 'released', actualCostMicros: 0,
        grantState: 'paused', evidenceKind: previous.evidence_kind, alreadyApplied: true }
      projectId = subject.projectId
      return
    }
    const preview = readCandidate(subject, commandId)
    if (preview.fingerprint !== confirmedFingerprint) throw new Error('Owner发送前对账来源已变化，请重新预览')
    const nowUpdated = database.prepare(`SELECT state, actual_cost_micros, usage_evidence, usage_record_key, reserved_cost_micros
      FROM project_owner_execution_commands WHERE id=? AND project_id=?`).get(commandId, subject.projectId) as {
        state: string; actual_cost_micros: number | null; usage_evidence: string | null; usage_record_key: string | null; reserved_cost_micros: number
      } | undefined
    if (!nowUpdated || nowUpdated.state !== 'needs_reconcile' || nowUpdated.actual_cost_micros !== null
      || nowUpdated.reserved_cost_micros !== preview.reservedCostMicros
      || (nowUpdated.usage_evidence === null ? null : errorHash(nowUpdated.usage_evidence)) !== preview.preReconciliationUsageEvidenceSha256
      || (nowUpdated.usage_record_key === null ? null : errorHash(nowUpdated.usage_record_key)) !== preview.preReconciliationUsageRecordKeySha256) {
      throw new Error('Owner命令结算状态已变化，保留原占额')
    }
    const reconciliationId = randomUUID()
    database.prepare(`INSERT INTO project_owner_execution_preflight_reconciliations
      (reconciliation_id, command_id, execution_id, project_id, grant_id, channel_id, model_id, evidence_kind,
       reason_code, error_sha256, request_reservation_count, provider_console_checked_no_usage,
       pre_reconciliation_usage_marker, pre_reconciliation_usage_evidence_sha256, pre_reconciliation_usage_record_key_sha256,
       reserved_cost_micros, confirmed_fingerprint, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, 'local-user', ?)`)
      .run(reconciliationId, commandId, preview.executionId, subject.projectId, preview.grantId, preview.channelId,
        preview.modelId, preview.evidenceKind, preview.reasonCode, preview.errorSha256, preview.preReconciliationUsageMarker,
        preview.preReconciliationUsageEvidenceSha256, preview.preReconciliationUsageRecordKeySha256,
        preview.reservedCostMicros, confirmedFingerprint, now)
    const commandUpdate = database.prepare(`UPDATE project_owner_execution_commands
      SET state='released', actual_cost_micros=0, usage_evidence=NULL, usage_record_key=NULL, updated_at=?
      WHERE id=? AND project_id=? AND state='needs_reconcile' AND actual_cost_micros IS NULL AND usage_evidence IS ? AND usage_record_key IS ?`)
      .run(now, commandId, subject.projectId, nowUpdated.usage_evidence, nowUpdated.usage_record_key)
    if (commandUpdate.changes !== 1) throw new Error('Owner命令释放状态竞争失败，事务回滚')
    const grantUpdate = database.prepare(`UPDATE project_owner_execution_grants SET state='paused'
      WHERE id=? AND project_id=? AND state='needs_reconcile'`).run(preview.grantId, subject.projectId)
    if (grantUpdate.changes !== 1) throw new Error('Owner授权暂停状态竞争失败，事务回滚')
    result = { commandId, reconciliationId, state: 'released', actualCostMicros: 0,
      grantState: 'paused', evidenceKind: preview.evidenceKind, alreadyApplied: false }
    projectId = subject.projectId
  })()
  if (!result) throw new Error('Owner发送前对账未完成')
  if (projectId) requestOwnerAutonomousScheduleWake(projectId)
  return result
}
