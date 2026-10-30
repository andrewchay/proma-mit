/** 打包烟测专用：为一次明确指定的 Owner 协议失败追加新观察，不重放旧请求或旧决定。 */
import { randomUUID } from 'node:crypto'
import * as store from './project-sqlite-store'
import { getProjectOwnerGoalDraft } from './project-owner-goal-service'
import { readOwnerExecutionObservation } from './project-owner-management-execution'
import { recordOwnerManagementObservation } from './project-owner-management-store'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { getOwnerQualityRecovery } from './project-owner-quality-actions'
import { readOwnerPlanningSnapshot } from './project-owner-planning-source'
import { getOwnerPlanningRunOutcome, getOwnerPlanningRunReceipt } from './project-owner-planning-run-service'
import { confirmOwnerManagementDelegation, getOwnerManagementDelegation, previewOwnerManagementDelegation, revokeOwnerManagementDelegation } from './project-owner-management-delegation'
import { getOwnerExecutionRevalidation, previewOwnerExecutionRevalidation, saveOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { getOwnerExecutionGrant, hashOwnerGrantApproval } from './project-owner-execution-grant-issue'
import { getOwnerCarrierFacts, getOwnerRuntimeBinding, ownerCarrierBindingMatches, saveOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { getPilotPolicy } from './project-pilot-policy'
import { getChannelById } from './channel-manager'

function failedQualitySource(projectId: string, ownerExecutionId: string, expectedDetail = 'Owner质量决定未按准确标准逐项判断或引用不符') {
  if (process.env.GRAVITAS_PACKAGE_SMOKE !== '1' || process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID !== ownerExecutionId) throw new Error('质量协议恢复必须由打包烟测显式指定')
  const outcome = getOwnerPlanningRunOutcome(ownerExecutionId), receipt = outcome ? getOwnerPlanningRunReceipt(outcome.receiptId) : null
  const snapshot = receipt ? readOwnerPlanningSnapshot(receipt.planningTaskId, { allowUnknownPromptForHistory: true }) : null, original = snapshot?.context.conversation?.executionObservation
  if (outcome?.state !== 'failed' || outcome.detail !== expectedDetail || receipt?.projectId !== projectId || original?.role !== 'reviewer') throw new Error('质量协议恢复缺少准确的原失败执行')
  return { original, targetTaskId: snapshot?.link.targetTaskId, artifactHash: snapshot?.context.conversation?.deliveryReview?.developmentArtifact?.contentHash }
}

const revalidationFailureDetail = 'Owner不能在独立检查未通过或标准未满足时接受成果'

/** 用户明确续期或授权原成果复验时才调用；追加委托，不重放失败请求或改写原决定。 */
export function renewExpiredOwnerQualityAuthorizationForSmoke(projectId: string, ownerExecutionId: string, revalidationArtifactHash?: string): void {
  const revalidationRecovery = revalidationArtifactHash !== undefined
  if (revalidationRecovery && (!/^[a-f0-9]{64}$/.test(revalidationArtifactHash) || process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH !== revalidationArtifactHash)) throw new Error('Owner复验委托必须绑定准确成果哈希')
  const { original, targetTaskId } = failedQualitySource(projectId, ownerExecutionId, revalidationRecovery ? revalidationFailureDetail : undefined)
  const subject = { projectId, ...(targetTaskId ? { taskId: targetTaskId } : {}) }, now = Date.now(), maxRequests = Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS)
  const renewalDurationMs = Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RENEWAL_DURATION_MS ?? 3600_000)
  const management = getOwnerManagementDelegation(projectId, targetTaskId), previous = management.delegation
  const localUnsentFailure = management.state === 'stale' && management.detail === '上次在本地配置检查阶段失败，未进入模型请求发送。请保存服务凭据后重新核对项目预算；原失败和保守预留仍保留，不自动重发，也不补造模型用量或账单。'
  const grantRow = store.getProjectDb().prepare("SELECT g.* FROM project_owner_execution_grants g JOIN project_owner_execution_commands c ON c.grant_id=g.id WHERE c.id=? AND c.project_id=? AND c.role='reviewer'").get(original.commandId, projectId) as { id: string; state: string; expires_at: number; max_cost_micros: number; max_runs: number; max_rework: number } | undefined
  if (!previous || !grantRow || grantRow.state !== 'active' || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || ![3600_000, 7200_000].includes(renewalDurationMs)) throw new Error('续期缺少有效原授权、累计请求上限或明确的续期时长')
  const maxCostMicros = Number(process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS ?? previous.maxCostMicros)
  if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros < previous.maxCostMicros) throw new Error('续期不得降低原项目预算上限')
  const latestClaim = revalidationRecovery ? store.getProjectDb().prepare('SELECT execution_id FROM project_owner_management_claims WHERE delegation_id=? ORDER BY rowid DESC LIMIT 1').get(previous.id) as { execution_id: string } | undefined : undefined
  const check = management.attentionCheck, outcome = getOwnerPlanningRunOutcome(ownerExecutionId), receipt = outcome ? getOwnerPlanningRunReceipt(outcome.receiptId) : null
  const exactRevalidationAttention = revalidationRecovery && management.state === 'attention' && latestClaim?.execution_id === ownerExecutionId
    && check?.reason === 'non_continueable_outcome' && check.executionStatus === 'failed' && check.outcomeState === 'failed' && check.outcomeDetail === revalidationFailureDetail
    && Number.isSafeInteger(check.inputTokens) && Number(check.inputTokens) >= 0 && Number.isSafeInteger(check.outputTokens) && Number(check.outputTokens) >= 0
    && receipt?.validTerminal === true && receipt.error === null && receipt.runtimeResult?.subtype === 'success'
    && previous.expiresAt > now && grantRow.expires_at > now
  const reusable = management.state === 'active' && previous.qualityDecisionEnabled === true && previous.maxRequests === maxRequests && previous.maxCostMicros === maxCostMicros && previous.expiresAt > now
    && (revalidationRecovery ? grantRow.expires_at > now : grantRow.expires_at === previous.expiresAt)
  if (maxRequests < previous.maxRequests) throw new Error('续期必须绑定已到期的原授权，且累计请求上限不得低于原额度')
  const authorizedContinuation = revalidationRecovery ? exactRevalidationAttention : localUnsentFailure
  if (!reusable && !authorizedContinuation && (previous.expiresAt > now || grantRow.expires_at > now)) throw new Error(revalidationRecovery ? 'Owner复验只允许替换本次准确失败导致的attention委托' : '续期必须绑定已到期的原授权，且累计请求上限不得低于原额度')
  const pending = store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=? AND (state NOT IN ('settled','released') OR actual_cost_micros IS NULL OR usage_evidence IS NULL)").get(grantRow.id) as { count: number }
  if (pending.count) throw new Error('原执行授权仍有未结算或未知命令，不能续期')
  const existingGrant = getOwnerExecutionGrant(subject)
  if (!existingGrant || existingGrant.grantId !== grantRow.id || existingGrant.state !== 'active') throw new Error('原执行授权来源无法核验')
  const expiresAt = reusable || exactRevalidationAttention ? previous.expiresAt : now + renewalDurationMs
  const executionExpiresAt = revalidationRecovery && (reusable || exactRevalidationAttention) ? existingGrant.budget.expiresAt : expiresAt
  const durationLabel = renewalDurationMs === 7200_000 ? '两小时' : '一小时'
  let renewedDelegation = previous
  if (!reusable) {
    const ownerBinding = getOwnerRuntimeBinding(projectId)
    if (!ownerBinding) throw new Error('续期缺少原Owner配置绑定')
    const facts = getOwnerCarrierFacts(projectId, ownerBinding.carrierId, ownerBinding.workspaceId)
    if (ownerBinding.channelId !== facts.channelId || ownerBinding.modelId !== facts.modelId || ownerBinding.runtime !== facts.runtime) throw new Error('续期不得切换Owner渠道、模型或Runtime')
    if (!ownerCarrierBindingMatches(ownerBinding, facts)) {
      const active = store.getProjectDb().prepare(`SELECT 1 AS active FROM project_owner_planning_links l
        JOIN agent_executions e ON e.entity_type='task' AND e.entity_id=l.planning_task_id
        WHERE l.project_id=? AND e.status IN ('queued','running') LIMIT 1`).get(projectId)
      if (active) throw new Error('Owner上一条请求仍在排队或运行，不能刷新续期配置')
      // 本次明确续期即重新确认当前本地配置；身份不变，旧绑定和原失败均保留。
      saveOwnerRuntimeBinding(projectId, ownerBinding.revision, { ownerName: ownerBinding.ownerName, carrierId: ownerBinding.carrierId, workspaceId: ownerBinding.workspaceId,
        changeReason: '用户明确续期；重新确认同一Owner、渠道和模型的当前本地配置，不扩大原执行范围' })
    }
    const authorization = { projectId, ...(targetTaskId ? { taskId: targetTaskId } : {}), requestId: randomUUID(), maxRequests, maxCostMicros, expiresAt, autonomousExecution: true }
    const preview = previewOwnerManagementDelegation(authorization)
    revokeOwnerManagementDelegation(projectId, previous.id)
    renewedDelegation = confirmOwnerManagementDelegation({ input: authorization, previewHash: preview.previewHash })
  }
  const current = getOwnerExecutionRevalidation(subject)
  let successor = current.status === 'current' && current.revalidation?.source.budget.expiresAt === executionExpiresAt ? current.revalidation : null
  if (!successor) {
    if (!current.revalidation) throw new Error('原再验证记录缺失，不能续期')
    const policyRevision = getPilotPolicy(projectId)?.revision
    if (!policyRevision) throw new Error('原执行策略缺失，不能续期')
    const input = {
      requestId: randomUUID(), expectedRevalidationRevision: current.revision,
      expectedMaterializationId: existingGrant.materializationId, expectedMaterializationRevision: existingGrant.materializationRevision,
      expectedMaterializationHash: existingGrant.materializationIntegrityHash, expectedPolicyRevision: policyRevision,
      renewalExpiresAt: executionExpiresAt, changeReason: `用户明确续期${durationLabel}；顺延期限并冻结当前同身份渠道与Owner配置，保留原成果、费用与员工次数`,
    }
    const preview = previewOwnerExecutionRevalidation(subject, input)
    successor = saveOwnerExecutionRevalidation(subject, input, preview.previewFingerprint)
  }
  const expectedSource = { ...current.revalidation!.source, budget: { ...current.revalidation!.source.budget, expiresAt: executionExpiresAt } }
  const previousProvenance = expectedSource.ownerBindingProvenance, nextProvenance = successor.source.ownerBindingProvenance
  const renewedBinding = getOwnerRuntimeBinding(projectId), currentChannel = getChannelById(successor.source.channelId)
  const configurationRenewalValid = previousProvenance.state === 'bound' && nextProvenance.state === 'bound' && renewedBinding && currentChannel
    && previousProvenance.carrierId === nextProvenance.carrierId && nextProvenance.carrierId === renewedBinding.carrierId
    && nextProvenance.bindingRevision === renewedBinding.revision && nextProvenance.carrierFingerprint === renewedBinding.carrierFingerprint
    && nextProvenance.bindingHash === ownerExecutionHash(renewedBinding) && successor.source.channelHash === ownerExecutionHash(currentChannel)
    && ownerCarrierBindingMatches(renewedBinding, getOwnerCarrierFacts(projectId, renewedBinding.carrierId, renewedBinding.workspaceId))
  if (!configurationRenewalValid) throw new Error('续期配置不是同一Owner载体与当前渠道的可核验证据')
  const comparableSuccessor = { ...successor.source, channelHash: expectedSource.channelHash, ownerBindingProvenance: expectedSource.ownerBindingProvenance,
    ...(successor.source.employeeRuntimes ? { employeeRuntimes: successor.source.employeeRuntimes.map((runtime, index) => ({ ...runtime, channelHash: expectedSource.employeeRuntimes?.[index]?.channelHash ?? runtime.channelHash })) } : {}) }
  if (ownerExecutionHash(comparableSuccessor) !== ownerExecutionHash(expectedSource)) throw new Error('续期改变了期限与同身份配置之外的冻结业务事实')
  if (successor.source.budget.maxCostMicros !== grantRow.max_cost_micros || successor.source.budget.maxRuns !== grantRow.max_runs || successor.source.budget.maxRework !== grantRow.max_rework) throw new Error('续期不得改变费用、员工次数或返工上限')
  const sourceHash = ownerExecutionHash(successor.source), policyRevision = successor.policyRevision
  const approvalFingerprint = hashOwnerGrantApproval({ subject, revalidation: { id: successor.id, revision: successor.revision, integrityHash: successor.integrityHash }, sourceHash, policyRevision,
    executorEmployeeId: existingGrant.executorEmployeeId, reviewerEmployeeId: existingGrant.reviewerEmployeeId,
    ...(existingGrant.roleAssignments ? { roleAssignments: existingGrant.roleAssignments.map(({ roleKey, employeeId }) => ({ roleKey, employeeId })) } : {}),
    workspaceId: existingGrant.workspaceId, channelId: existingGrant.channelId, modelId: existingGrant.modelId, runtime: existingGrant.runtime,
    budget: successor.source.budget, ownerManagementDelegationId: renewedDelegation.id, dispatchMode: existingGrant.dispatchMode })
  if (existingGrant.revalidationId === successor.id && existingGrant.revalidationIntegrityHash === successor.integrityHash && existingGrant.policyRevision === policyRevision
    && existingGrant.ownerManagementDelegationId === renewedDelegation.id && existingGrant.sourceHash === sourceHash && existingGrant.approvalFingerprint === approvalFingerprint && existingGrant.budget.expiresAt === executionExpiresAt) return
  store.getProjectDb().transaction(() => {
    const changed = store.getProjectDb().prepare(`UPDATE project_owner_execution_grants SET revalidation_id=?,revalidation_revision=?,revalidation_integrity_hash=?,policy_revision=?,owner_management_delegation_id=?,expires_at=?,approval_fingerprint=?,source_hash=?
      WHERE id=? AND project_id=? AND state='active' AND revalidation_id=? AND revalidation_integrity_hash=? AND expires_at=?`).run(successor.id, successor.revision, successor.integrityHash, policyRevision, renewedDelegation.id, executionExpiresAt, approvalFingerprint, sourceHash,
      grantRow.id, projectId, existingGrant.revalidationId, existingGrant.revalidationIntegrityHash, existingGrant.budget.expiresAt)
    if (changed.changes !== 1) throw new Error('原执行授权在续期期间发生变化')
    store.recordProjectActivity({ projectId, entityType: 'task', entityId: original.businessTaskId, action: exactRevalidationAttention ? 'owner_quality_smoke_revalidation_delegated' : 'owner_quality_smoke_renewed', actor: 'local-user',
      summary: exactRevalidationAttention ? '用户明确授权原成果复验；追加同期限、同累计上限的新管理委托，原失败、成果与费用账本保持不变。' : `用户明确续期${durationLabel}；追加继任再验证，原成果、员工费用与次数、返工额度和执行历史保持不变。`,
      payload: { grantId: grantRow.id, previousExpiresAt: existingGrant.budget.expiresAt, expiresAt: executionExpiresAt, previousDelegationId: previous.id, delegationId: renewedDelegation.id, previousRevalidationId: existingGrant.revalidationId, revalidationId: successor.id, maxRequests, previousMaxCostMicros: previous.maxCostMicros, maxCostMicros, executionMaxCostMicros: grantRow.max_cost_micros, maxRuns: grantRow.max_runs, maxRework: grantRow.max_rework } })
  })()
}

export function authorizeOwnerQualityRevalidationFromFailedRun(projectId: string, ownerExecutionId: string, artifactHash: string): void {
  const { original, targetTaskId: linkedTaskId, artifactHash: originalArtifactHash } = failedQualitySource(projectId, ownerExecutionId, revalidationFailureDetail)
  const targetTaskId = original.businessTaskId
  if (!targetTaskId || linkedTaskId && linkedTaskId !== targetTaskId) throw new Error('Owner复验缺少一致的原业务Task')
  if (originalArtifactHash !== artifactHash) throw new Error('Owner复验必须绑定原失败快照中的准确成果哈希')
  const executor = store.getProjectDb().prepare("SELECT id FROM project_owner_execution_commands WHERE project_id=? AND source_task_id=? AND role='executor' AND rework_ordinal=0 AND state='settled'").get(projectId, targetTaskId) as { id: string } | undefined
  if (!executor) throw new Error('Owner复验缺少原Executor结算记录')
  renewExpiredOwnerQualityAuthorizationForSmoke(projectId, ownerExecutionId, artifactHash)
  ;(require('./owner-quality-revalidation-smoke') as typeof import('./owner-quality-revalidation-smoke')).authorizeOwnerQualityRevalidationForSmoke({
    projectId, taskId: targetTaskId, originalOwnerExecutionId: ownerExecutionId,
    originalReviewerCommandId: original.commandId, originalExecutorCommandId: executor.id, artifactHash,
  })
}

export function resumeFailedOwnerQualityForSmoke(projectId: string, ownerExecutionId: string): void {
  const { original, targetTaskId } = failedQualitySource(projectId, ownerExecutionId)
  const recovery = getOwnerQualityRecovery(projectId, original.commandId)
  if (!recovery || recovery.previousExecutionId !== ownerExecutionId) throw new Error('当前业务事实不允许恢复质量判断')
  const current = readOwnerExecutionObservation(projectId, original.executionId, 'terminal')
  const goal = getProjectOwnerGoalDraft(projectId, current.taskId)
  if (!goal || current.observation.commandId !== original.commandId) throw new Error('质量协议恢复的业务来源已经变化')
  const observationHash = ownerExecutionHash({ observation: current.observation, recovery })
  recordOwnerManagementObservation(projectId, goal.revision, current.observation, current.taskId ?? targetTaskId, observationHash)
}
