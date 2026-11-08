/** Owner执行授权续期：用户明确确认后仅顺延授权期限。
 * 在同一条授权行上原地续期（grant_id 不变），调度器与质量记录仍按原授权关联，
 * 不清零累计费用、不重置运行次数、不重复执行已完成工作。
 * 未知费用、未收敛命令、来源漂移、配置变化或并发修改都会阻止续期。 */
import { randomUUID } from 'node:crypto'
import type { OwnerExecutionGrant, OwnerExecutionGrantRenewalPreview, OwnerExecutionRevalidationRecord, OwnerExecutionRevalidationSource, ProjectOwnerGoalSubject } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getChannelById } from './channel-manager'
import { readOwnerGrantUsage } from './project-owner-execution-settlement'
import { getOwnerExecutionRevalidation, listOwnerExecutionRevalidationHistory, previewOwnerExecutionRevalidation, saveOwnerExecutionRevalidation, withOwnerExecutionRenewalScope } from './project-owner-execution-revalidation'
import { getOwnerExecutionGrant } from './project-owner-execution-grant-issue'
import { getOwnerManagementDelegation } from './project-owner-management-delegation'
import { getOwnerRuntimeBinding, getOwnerCarrierFacts, ownerCarrierBindingMatches } from './project-owner-runtime-binding'
import { getPilotPolicy } from './project-pilot-policy'
import { OwnerExecutionPreparationConflictError, ownerExecutionHash, ownerExecutionObject, parseOwnerExecutionSubject } from './project-owner-execution-source'

function fail(message: string): never {
  if (/已更新|已变化|已过期|指纹|版本|漂移|并发/.test(message)) throw new OwnerExecutionPreparationConflictError(`Owner续期：${message}`)
  throw new Error(`Owner续期：${message}`)
}
const RENEWAL_WINDOW_MS = 7 * 86400000

function parseRenewalInput(raw: unknown): { requestId: string; expiresAt: number } {
  const value = ownerExecutionObject(raw, ['requestId', 'expiresAt'])
  if (typeof value.requestId !== 'string' || !value.requestId.trim() || value.requestId.length > 200) fail('请求ID无效')
  if (!Number.isSafeInteger(value.expiresAt)) fail('续期期限无效')
  return { requestId: value.requestId as string, expiresAt: Number(value.expiresAt) }
}
interface RenewalPlan {
  subject: ProjectOwnerGoalSubject
  grant: OwnerExecutionGrant
  expiresAt: number
  /** 已存在的继任记录（重试复用）；为 null 时确认阶段需先保存继任再验证 */
  successor: OwnerExecutionRevalidationRecord | null
  successorSource: OwnerExecutionRevalidationSource
  successorInput: Parameters<typeof saveOwnerExecutionRevalidation>[1] | null
  successorPreviewFingerprint: string | null
  renewalFingerprint: string
  ownerManagementDelegationId: string
}
/** 承诺本次续期只改期限：继任来源与冻结来源逐项可比，差异仅限续期期限。 */
function assertRenewalOnlyExtendsExpiry(current: OwnerExecutionRevalidationRecord, successorSource: OwnerExecutionRevalidationSource): void {
  const expectedSource = { ...current.source, budget: { ...current.source.budget, expiresAt: successorSource.budget.expiresAt } }
  const comparableSuccessor = {
    ...successorSource,
    channelHash: expectedSource.channelHash,
    ownerBindingProvenance: expectedSource.ownerBindingProvenance,
    ...(successorSource.employeeRuntimes ? { employeeRuntimes: successorSource.employeeRuntimes.map((runtime, index) => ({ ...runtime, channelHash: expectedSource.employeeRuntimes?.[index]?.channelHash ?? runtime.channelHash })) } : {}),
  }
  if (ownerExecutionHash(comparableSuccessor) !== ownerExecutionHash(expectedSource)) fail('续期改变了期限以外的冻结业务事实')
  const budget = successorSource.budget
  if (budget.maxCostMicros !== current.source.budget.maxCostMicros || budget.maxRuns !== current.source.budget.maxRuns || budget.maxRework !== current.source.budget.maxRework)
    fail('续期不得改变费用、员工次数或返工上限')
}
/** 续期配置必须是同一Owner载体与当前渠道的可核验证据；本地配置漂移时拒绝续期。 */
function assertRenewalConfigurationCurrent(successorSource: OwnerExecutionRevalidationSource, projectId: string): void {
  const provenance = successorSource.ownerBindingProvenance
  const binding = getOwnerRuntimeBinding(projectId)
  const channel = getChannelById(successorSource.channelId)
  if (provenance.state !== 'bound' || !binding || !channel || provenance.carrierId !== binding.carrierId
    || provenance.bindingRevision !== binding.revision || provenance.carrierFingerprint !== binding.carrierFingerprint
    || provenance.bindingHash !== ownerExecutionHash(binding) || successorSource.channelHash !== ownerExecutionHash(channel)
    || !ownerCarrierBindingMatches(binding, getOwnerCarrierFacts(projectId, binding.carrierId, binding.workspaceId)))
    fail('续期配置不是同一Owner载体与当前渠道的可核验证据')
}
function assertRenewalEmployeesAndChannel(grant: OwnerExecutionGrant): void {
  const employeeIds = [grant.executorEmployeeId, grant.reviewerEmployeeId, ...(grant.roleAssignments?.map(assignment => assignment.employeeId) ?? [])]
  if (employeeIds.some(employeeId => !store.getAgentEmployee(employeeId)?.enabled)) fail('冻结员工已停用，不能续期')
  if (!getChannelById(grant.channelId)) fail('冻结渠道不可用，不能续期')
}
function assertGrantLedgerSettled(grantId: string): void {
  const pending = store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=? AND (state NOT IN ('settled','released') OR actual_cost_micros IS NULL OR usage_evidence IS NULL)").get(grantId) as { count: number }
  if (pending.count !== 0) fail('原执行授权仍有未结算命令或未知用量，不能续期')
}
function buildRenewalPlan(subject: ProjectOwnerGoalSubject, expiresAt: number): RenewalPlan {
  assertLocalActorEnabled()
  const now = Date.now()
  const grant = getOwnerExecutionGrant(subject)
  if (!grant) fail('当前没有可续期的执行授权')
  if (grant.state !== 'active') fail('授权已不在活动状态，不能续期')
  if (expiresAt <= now) fail('续期期限须在未来')
  if (expiresAt <= grant.budget.expiresAt) fail('续期期限须晚于原授权期限')
  if (expiresAt > now + RENEWAL_WINDOW_MS) fail('续期期限超出未来七天窗口')
  // 自主派工持续受原管理授权约束；管理授权被重新确认（换发新ID）后不再自动一致。
  const management = getOwnerManagementDelegation(subject.projectId, subject.taskId)
  if (!management.delegation || !['active', 'exhausted'].includes(management.state)) fail('续期需要当前有效的项目管理总预算授权')
  if (grant.ownerManagementDelegationId !== management.delegation.id) fail('项目管理授权已重新确认，与冻结执行授权不再一致；请撤权后按原流程重新发行')
  if (expiresAt > management.delegation.expiresAt) fail('续期期限不能超过项目管理总预算授权期限')
  assertGrantLedgerSettled(grant.grantId)
  assertRenewalEmployeesAndChannel(grant)
  const policy = getPilotPolicy(subject.projectId)
  const view = getOwnerExecutionRevalidation(subject)
  if (view.status !== 'current' || !view.revalidation) fail(`冻结来源不再current（${view.status}）；续期前需先核对漂移`)
  const record = view.revalidation
  let successor: OwnerExecutionRevalidationRecord | null = null
  let successorInput: RenewalPlan['successorInput'] = null
  let successorPreviewFingerprint: string | null = null
  let successorSource: OwnerExecutionRevalidationSource
  if (record.id === grant.revalidationId) {
    // 常规情况：授权仍指向最新再验证，需追加继任再验证记录（确认阶段保存）。
    if (record.revision !== grant.revalidationRevision || record.integrityHash !== grant.revalidationIntegrityHash
      || ownerExecutionHash(record.source) !== grant.sourceHash || grant.policyRevision !== record.policyRevision)
      fail('授权绑定的重验证证据已变化')
    successorInput = {
      requestId: randomUUID(),
      expectedRevalidationRevision: record.revision,
      expectedMaterializationId: grant.materializationId,
      expectedMaterializationRevision: grant.materializationRevision,
      expectedMaterializationHash: grant.materializationIntegrityHash,
      expectedPolicyRevision: policy?.revision ?? 0,
      renewalExpiresAt: expiresAt,
      changeReason: `用户明确续期执行授权；仅顺延期限至 ${new Date(expiresAt).toLocaleString('zh-CN')}`,
    }
    const preview = withOwnerExecutionRenewalScope(() => previewOwnerExecutionRevalidation(subject, successorInput))
    successorSource = preview.source
    successorPreviewFingerprint = preview.previewFingerprint
  } else {
    // 兼容重试：继任记录已保存但授权行未更新时直接复用，不重复追加记录。
    if (record.source.budget.expiresAt !== expiresAt || record.source.materialization.id !== grant.materializationId
      || record.source.materialization.revision !== grant.materializationRevision || record.source.materialization.integrityHash !== grant.materializationIntegrityHash)
      fail('授权与最新重验证记录不一致')
    const prior = listOwnerExecutionRevalidationHistory(subject).find(item => item.id === grant.revalidationId)
    if (!prior) fail('授权绑定的原重验证证据缺失')
    successor = record
    successorSource = record.source
    assertRenewalOnlyExtendsExpiry(prior, successorSource)
  }
  assertRenewalOnlyExtendsExpiry(record, successorSource)
  assertRenewalConfigurationCurrent(successorSource, subject.projectId)
  // 预览指纹只绑定授权行上的稳定事实（保存继任记录或并发变化都不会改变它），
  // 确认阶段另以乐观行锁防止授权行被并发修改。
  const renewalFingerprint = ownerExecutionHash({
    projectId: subject.projectId, taskId: subject.taskId ?? null, grantId: grant.grantId,
    previousExpiresAt: grant.budget.expiresAt, expiresAt,
    grantRevalidation: { id: grant.revalidationId, revision: grant.revalidationRevision, integrityHash: grant.revalidationIntegrityHash },
    materialization: { id: grant.materializationId, revision: grant.materializationRevision, integrityHash: grant.materializationIntegrityHash },
    ownerManagementDelegationId: management.delegation.id,
  })
  return { subject, grant, expiresAt, successor, successorSource, successorInput, successorPreviewFingerprint, renewalFingerprint, ownerManagementDelegationId: management.delegation.id }
}
export function previewOwnerExecutionGrantRenewal(rawSubject: unknown, rawInput: unknown): OwnerExecutionGrantRenewalPreview {
  const subject = parseOwnerExecutionSubject(rawSubject), input = parseRenewalInput(rawInput)
  const plan = buildRenewalPlan(subject, input.expiresAt)
  const usage = readOwnerGrantUsage(plan.grant.grantId)
  return {
    ...subject,
    grantId: plan.grant.grantId,
    grantState: 'active',
    previousExpiresAt: plan.grant.budget.expiresAt,
    expiresAt: plan.expiresAt,
    budget: { ...plan.successorSource.budget },
    usage: { committedCostMicros: usage.committedCostMicros, reservedCostMicros: 0, runReservations: usage.runReservations },
    ownerManagementDelegationId: plan.ownerManagementDelegationId,
    renewalFingerprint: plan.renewalFingerprint,
  }
}
export function confirmOwnerExecutionGrantRenewal(rawSubject: unknown, rawRequest: unknown): OwnerExecutionGrant {
  const subject = parseOwnerExecutionSubject(rawSubject)
  const value = ownerExecutionObject(rawRequest, ['input', 'preview', 'confirmedFingerprint'])
  const input = parseRenewalInput(value.input)
  const preview = value.preview as OwnerExecutionGrantRenewalPreview
  if (typeof value.confirmedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.confirmedFingerprint)) fail('确认指纹无效')
  const database = store.getProjectDb()
  if (database.isTransactionActive()) fail('拒绝未提交外层事务')
  const plan = buildRenewalPlan(subject, input.expiresAt)
  if (plan.renewalFingerprint !== value.confirmedFingerprint || preview.renewalFingerprint !== value.confirmedFingerprint
    || preview.grantId !== plan.grant.grantId || preview.previousExpiresAt !== plan.grant.budget.expiresAt || preview.expiresAt !== plan.expiresAt)
    fail('续期预览已更新，请重新预览')
  // 先追加继任再验证（自带策略锁与事务）；失败时授权行保持不变。
  const successor = plan.successor
    ?? withOwnerExecutionRenewalScope(() => saveOwnerExecutionRevalidation(subject, plan.successorInput, plan.successorPreviewFingerprint))
  if (ownerExecutionHash(successor.source) !== ownerExecutionHash(plan.successorSource)) fail('继任再验证已变化，请重新预览')
  const approvalFingerprint = ownerExecutionHash({ renewal: plan.renewalFingerprint, successor: { id: successor.id, revision: successor.revision, integrityHash: successor.integrityHash } })
  const sourceHash = ownerExecutionHash(successor.source)
  let saved: OwnerExecutionGrant | null = null
  database.transaction(() => {
    const changed = database.prepare(`UPDATE project_owner_execution_grants SET revalidation_id=?, revalidation_revision=?, revalidation_integrity_hash=?,
        policy_revision=?, owner_management_delegation_id=?, expires_at=?, max_cost_micros=?, max_runs=?, max_rework=?, approval_fingerprint=?, source_hash=?
      WHERE id=? AND project_id=? AND state='active' AND revalidation_id=? AND revalidation_revision=? AND revalidation_integrity_hash=? AND expires_at=? AND approval_fingerprint=?`).run(
      successor.id, successor.revision, successor.integrityHash,
      successor.policyRevision, plan.ownerManagementDelegationId, plan.expiresAt,
      successor.source.budget.maxCostMicros, successor.source.budget.maxRuns, successor.source.budget.maxRework,
      approvalFingerprint, sourceHash,
      plan.grant.grantId, subject.projectId,
      plan.grant.revalidationId, plan.grant.revalidationRevision, plan.grant.revalidationIntegrityHash, plan.grant.budget.expiresAt, plan.grant.approvalFingerprint)
    if (changed.changes !== 1) fail('原执行授权在续期期间发生变化，请重新预览')
    const renewedAt = Date.now()
    database.prepare('INSERT INTO project_owner_execution_grant_decisions(grant_id,project_id,action,fingerprint,impact,actor,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(plan.grant.grantId, subject.projectId, 'renew', plan.renewalFingerprint, JSON.stringify({ previousExpiresAt: plan.grant.budget.expiresAt, expiresAt: plan.expiresAt, revalidationId: successor.id, revalidationRevision: successor.revision }), 'local-user', renewedAt)
    saved = getOwnerExecutionGrant(subject)
  })()
  if (!saved) fail('事务未保存续期结果')
  store.recordProjectActivity({
    projectId: subject.projectId, entityType: 'task', entityId: subject.taskId ?? subject.projectId, action: 'owner_execution_grant_renewed', actor: 'local-user',
    summary: `用户明确续期执行授权；期限顺延至 ${new Date(plan.expiresAt).toLocaleString('zh-CN')}。原任务、命令、评审、费用与运行次数证据保持不变，调度按原授权进度继续。`,
    payload: { grantId: plan.grant.grantId, previousExpiresAt: plan.grant.budget.expiresAt, expiresAt: plan.expiresAt, previousRevalidationId: plan.grant.revalidationId, revalidationId: successor.id, ownerManagementDelegationId: plan.ownerManagementDelegationId },
  })
  return saved
}
