/** Owner执行授权账本：发行/撤权；发行是"允许按账本消费"的静态许可，无任何消费路径。 */
import { randomUUID } from 'node:crypto'
import { getAgentProviderProtocol, type OwnerExecutionGrant, type OwnerExecutionGrantBudget, type OwnerExecutionGrantIssuePreview, type OwnerExecutionGrantRevokePreview, type OwnerExecutionRevalidationRecord, type OwnerExecutionRoleBudgetCap, type ProjectOwnerGoalSubject } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { getChannelById } from './channel-manager'
import { PILOT_DEFAULT_PRICE_EVIDENCE_ID } from './project-pilot-request-exit'
import { getPilotReviewedPriceEvidence } from './project-pilot-request-evidence'
import { assertLocalActorEnabled } from './project-owner-plan-service'
import { getAgentEmployee } from './project-sqlite-store'
import { assertOwnerExecutionBoundaryIdle } from './project-owner-execution-preparation-evidence'
import { getOwnerExecutionRevalidation } from './project-owner-execution-revalidation'
import { OwnerExecutionPreparationConflictError, ownerExecutionHash, ownerExecutionObject, parseOwnerExecutionSubject } from './project-owner-execution-source'
import { withPolicyLock } from './project-pilot-policy'

/** policy模块按需：无发行场景不把policy JSON图拉进窄mock测试。 */
type PolicyModule = typeof import('./project-pilot-policy')
let policyModule: PolicyModule | null = null
function pilotPolicy(): PolicyModule { return (policyModule ??= require('./project-pilot-policy') as PolicyModule) }

function fail(message: string): never {
  if (/已更新|已变化|已过期|指纹|版本|已存在|漂移/.test(message)) throw new OwnerExecutionPreparationConflictError(`Owner发行：${message}`)
  throw new Error(`Owner发行：${message}`)
}
export function hashOwnerGrantApproval(input: {
  subject: ProjectOwnerGoalSubject
  revalidation: { id: string; revision: number; integrityHash: string }
  sourceHash: string
  policyRevision: number
  executorEmployeeId: string
  reviewerEmployeeId: string
  roleAssignments?: Array<{ roleKey: string; employeeId: string }>
  workspaceId: string
  channelId: string
  modelId: string
  runtime: string
  budget: OwnerExecutionGrantBudget
  dispatchMode?: OwnerExecutionGrantIssuePreview['dispatchMode']
}): string {
  return ownerExecutionHash({ ...input, dispatchMode: input.dispatchMode ?? 'manual' })
}
function parseIssueInput(raw: unknown): { requestId: string; expectedRevalidationRevision: number; expectedPolicyRevision: number; dispatchMode: OwnerExecutionGrantIssuePreview['dispatchMode'] } {
  const value = ownerExecutionObject(raw, ['requestId', 'expectedRevalidationRevision', 'expectedPolicyRevision', 'dispatchMode'])
  if (typeof value.requestId !== 'string' || !value.requestId.trim() || value.requestId.length > 200) fail('请求ID无效')
  for (const [key, min] of [['expectedRevalidationRevision', 0], ['expectedPolicyRevision', 1]] as const) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < min) fail('版本无效')
  const dispatchMode = value.dispatchMode ?? 'manual'
  if (dispatchMode !== 'manual' && dispatchMode !== 'autonomous') fail('派发模式无效')
  return { requestId: value.requestId as string, expectedRevalidationRevision: Number(value.expectedRevalidationRevision), expectedPolicyRevision: Number(value.expectedPolicyRevision), dispatchMode }
}
function parseGrantRoleBudgetCaps(raw: unknown, maxCostMicros: number): OwnerExecutionRoleBudgetCap[] {
  let value: unknown
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { throw new Error('Owner授权岗位预算格式无效，保留原件核查') }
  if (!Array.isArray(value) || value.length > 200) throw new Error('Owner授权岗位预算格式无效，保留原件核查')
  const caps = value.map((item) => {
    const cap = ownerExecutionObject(item, ['roleKey', 'maxCostMicros'])
    if (typeof cap.roleKey !== 'string' || !cap.roleKey.trim() || !Number.isSafeInteger(cap.maxCostMicros) || Number(cap.maxCostMicros) <= 0 || Number(cap.maxCostMicros) > maxCostMicros)
      throw new Error('Owner授权岗位预算值无效，保留原件核查')
    return { roleKey: cap.roleKey, maxCostMicros: Number(cap.maxCostMicros) }
  }).sort((left, right) => left.roleKey < right.roleKey ? -1 : left.roleKey > right.roleKey ? 1 : 0)
  if (new Set(caps.map((item) => item.roleKey)).size !== caps.length) throw new Error('Owner授权岗位预算roleKey重复，保留原件核查')
  return caps
}
function rowToGrant(row: Record<string, unknown>): OwnerExecutionGrant {
  const sourceRow = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_execution_revalidations WHERE id=? AND project_id=?').get(String(row.revalidation_id), String(row.project_id)) as { payload: string; integrity_hash: string } | undefined
  if (!sourceRow) throw new Error('Owner授权引用的重验证证据缺失，保留原件核查')
  let record: OwnerExecutionRevalidationRecord
  try { record = JSON.parse(sourceRow.payload) as OwnerExecutionRevalidationRecord } catch { throw new Error('Owner授权引用的重验证证据无效，保留原件核查') }
  const { integrityHash, ...recordBody } = record
  if (record.id !== row.revalidation_id || record.projectId !== row.project_id || integrityHash !== sourceRow.integrity_hash
    || integrityHash !== ownerExecutionHash(recordBody) || ownerExecutionHash(record.source) !== row.source_hash)
    throw new Error('Owner授权与重验证证据摘要不匹配，保留原件核查')
  const roleBudgetCaps = parseGrantRoleBudgetCaps(row.role_budgets_json ?? '[]', row.max_cost_micros as number)
  if (ownerExecutionHash(roleBudgetCaps) !== ownerExecutionHash(record.source.budget.roleBudgetCaps ?? []))
    throw new Error('Owner授权岗位预算与重验证冻结来源不一致，保留原件核查')
  const assignmentByRole = new Map<string, { roleKey: string; employeeId: string; employeeName: string }>()
  for (const task of record.source.tasks) if (task.executor) {
    const assignment = { roleKey: task.executor.roleKey, employeeId: task.executor.id, employeeName: task.executor.name }
    const existing = assignmentByRole.get(assignment.roleKey)
    if (existing && existing.employeeId !== assignment.employeeId) throw new Error('Owner授权重验证证据中的roleKey员工映射冲突')
    assignmentByRole.set(assignment.roleKey, assignment)
  }
  const roleAssignments = assignmentByRole.size ? [...assignmentByRole.values()].sort((a, b) => a.roleKey.localeCompare(b.roleKey)) : undefined
  return {
    projectId: row.project_id as string,
    ...(row.task_id ? { taskId: row.task_id as string } : {}),
    policyRevision: row.policy_revision as number,
    revalidationId: row.revalidation_id as string,
    revalidationRevision: row.revalidation_revision as number,
    revalidationIntegrityHash: row.revalidation_integrity_hash as string,
    materializationId: row.materialization_id as string,
    materializationRevision: row.materialization_revision as number,
    materializationIntegrityHash: row.materialization_integrity_hash as string,
    sourceHash: row.source_hash as string,
    ...(roleAssignments ? { roleAssignments } : {}),
    executorEmployeeId: row.executor_employee_id as string,
    reviewerEmployeeId: row.reviewer_employee_id as string,
    workspaceId: row.workspace_id as string,
    channelId: row.channel_id as string,
    modelId: row.model_id as string,
    runtime: row.runtime as string,
    dispatchMode: (row.dispatch_mode as OwnerExecutionGrantIssuePreview['dispatchMode'] | undefined) ?? 'manual',
    budget: { maxCostMicros: row.max_cost_micros as number, maxRuns: row.max_runs as number, maxRework: row.max_rework as number, expiresAt: row.expires_at as number, ...(roleBudgetCaps.length ? { roleBudgetCaps } : {}) },
    blockers: [],
    approvalFingerprint: row.approval_fingerprint as string,
    grantId: row.id as string,
    state: row.state as OwnerExecutionGrant['state'],
    issuedAt: row.issued_at as number,
  }
}
export function listOwnerExecutionGrantHistory(rawSubject: unknown): OwnerExecutionGrant[] {
  const subject = parseOwnerExecutionSubject(rawSubject)
  return (store.getProjectDb().prepare('SELECT * FROM project_owner_execution_grants WHERE project_id=? AND task_id IS ? ORDER BY issued_at').all(subject.projectId, subject.taskId ?? null) as Array<Record<string, unknown>>).map(rowToGrant)
}
export function getOwnerExecutionGrant(rawSubject: unknown): OwnerExecutionGrant | null {
  return listOwnerExecutionGrantHistory(rawSubject).at(-1) ?? null
}
function resolveCurrentChain(subject: ProjectOwnerGoalSubject, input: { expectedRevalidationRevision: number; expectedPolicyRevision: number; dispatchMode: OwnerExecutionGrantIssuePreview['dispatchMode'] }): { record: OwnerExecutionRevalidationRecord; sourceHash: string; preview: OwnerExecutionGrantIssuePreview } {
  const view = getOwnerExecutionRevalidation(subject)
  if (view.status !== 'current' || !view.revalidation) fail(`重验证来源非current（${view.status}），不能发行`)
  const record = view.revalidation
  if (record.revision !== input.expectedRevalidationRevision) fail('重验证版本已更新，请重新预览')
  const sourceHash = ownerExecutionHash(record.source)
  const budget = record.source.budget
  if (budget.expiresAt <= Date.now()) fail('预算期限已过期，不能发行；不顺延')
  const executor = getAgentEmployee(record.source.executor.id), reviewer = getAgentEmployee(record.source.reviewer.id)
  const roleEmployeeIds = [...new Set(record.source.tasks.map((task) => task.executor?.id).filter((id): id is string => Boolean(id))) ]
  if (!roleEmployeeIds.length) roleEmployeeIds.push(record.source.executor.id)
  if (!executor?.enabled || !reviewer?.enabled || roleEmployeeIds.some((employeeId) => !getAgentEmployee(employeeId)?.enabled)) fail('发行前置失败：冻结员工已停用')
  const evidence = getPilotReviewedPriceEvidence(PILOT_DEFAULT_PRICE_EVIDENCE_ID)
  const channel = getChannelById(record.source.channelId)
  if (!evidence) fail('发行前置失败：已审核价格证据不可用')
  if (!channel) fail('发行前置失败：冻结渠道不可用')
  const protocol = getAgentProviderProtocol(channel.provider, 'ai-sdk')
  const evidenceProviderKind = protocol === 'openai-chat' ? 'openai' : protocol === 'anthropic-messages' ? 'anthropic' : 'google'
  if (evidenceProviderKind !== evidence.providerKind) fail(`发行前置失败：渠道协议与已审核价格证据不匹配（${evidenceProviderKind} / ${evidence.providerKind}）`)
  if (record.source.modelId !== evidence.model) fail(`发行前置失败：模型 ${record.source.modelId} 与已审核价格证据模型 ${evidence.model} 不匹配`)
  const roleAssignments = record.source.tasks.flatMap((task) => task.executor ? [{ roleKey: task.executor.roleKey, employeeId: task.executor.id, employeeName: task.executor.name }] : [])
    .filter((item, index, all) => all.findIndex((other) => other.roleKey === item.roleKey) === index)
    .sort((a, b) => a.roleKey.localeCompare(b.roleKey))
  const body = { ...subject, policyRevision: input.expectedPolicyRevision, revalidationId: record.id, revalidationRevision: record.revision, revalidationIntegrityHash: record.integrityHash, materializationId: record.source.materialization.id, materializationRevision: record.source.materialization.revision, materializationIntegrityHash: record.source.materialization.integrityHash, sourceHash, ...(roleAssignments.length ? { roleAssignments } : {}), executorEmployeeId: record.source.executor.id, reviewerEmployeeId: record.source.reviewer.id, workspaceId: record.source.workspaceId, channelId: record.source.channelId, modelId: record.source.modelId, runtime: record.source.runtime, dispatchMode: input.dispatchMode, budget: { ...budget }, blockers: [], approvalFingerprint: '' }
  const approvalFingerprint = hashOwnerGrantApproval({ subject, revalidation: { id: record.id, revision: record.revision, integrityHash: record.integrityHash }, sourceHash, policyRevision: input.expectedPolicyRevision, executorEmployeeId: body.executorEmployeeId, reviewerEmployeeId: body.reviewerEmployeeId, roleAssignments: roleAssignments.map(({ roleKey, employeeId }) => ({ roleKey, employeeId })), workspaceId: body.workspaceId, channelId: body.channelId, modelId: body.modelId, runtime: body.runtime, budget: { ...budget }, dispatchMode: input.dispatchMode })
  return { record, sourceHash, preview: { ...body, approvalFingerprint } }
}
export function previewOwnerExecutionGrantIssue(rawSubject: unknown, rawInput: unknown): OwnerExecutionGrantIssuePreview {
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject), input = parseIssueInput(rawInput)
  assertOwnerExecutionBoundaryIdle(subject.projectId)
  const currentPolicyRevision = pilotPolicy().getPilotPolicy(subject.projectId)?.revision ?? 0
  if (currentPolicyRevision !== input.expectedPolicyRevision) fail('策略已更新，请重新预览')
  const { preview } = resolveCurrentChain(subject, input)
  if (preview.policyRevision !== input.expectedPolicyRevision) fail('策略已更新，请重新预览')
  return preview
}
export function confirmOwnerExecutionGrantIssue(rawSubject: unknown, rawRequest: unknown): OwnerExecutionGrant {
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject)
  const value = ownerExecutionObject(rawRequest, ['input', 'preview', 'confirmedFingerprint'])
  const input = parseIssueInput(value.input)
  const preview = value.preview as OwnerExecutionGrantIssuePreview
  if (typeof value.confirmedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.confirmedFingerprint)) fail('确认指纹无效')
  const database = store.getProjectDb()
  if (database.isTransactionActive()) fail('拒绝未提交外层事务')
  const inputHash = ownerExecutionHash({ subject, input })
  const existingActive = listOwnerExecutionGrantHistory(subject).find(grant => grant.state === 'active')
  if (existingActive && existingActive.revalidationId === preview.revalidationId && existingActive.approvalFingerprint === preview.approvalFingerprint) {
    const storedHash = store.getProjectDb().prepare('SELECT input_hash FROM project_owner_execution_grants WHERE id=?').get(existingActive.grantId) as { input_hash: string } | undefined
    if (storedHash?.input_hash === String(inputHash)) return existingActive
    fail('请求ID已用于不同输入')
  }
  return withPolicyLock(() => {
    let saved: OwnerExecutionGrant | null = null
    database.transaction(() => {
      // active幂等分支在idle检查之前（镜像grant-issue）。
      const active = database.prepare("SELECT * FROM project_owner_execution_grants WHERE project_id=? AND state='active'").get(subject.projectId) as Record<string, unknown> | undefined
      if (active) {
        const grant = rowToGrant(active)
        if (grant.revalidationId === preview.revalidationId && grant.approvalFingerprint === preview.approvalFingerprint) {
          if ((active.input_hash as string) !== String(inputHash)) fail('请求ID已用于不同输入')
          saved = grant
          return
        }
        fail('项目已存在其他活动授权，请先撤权')
      }
      assertOwnerExecutionBoundaryIdle(subject.projectId)
      const liveRevision = pilotPolicy().getPilotPolicy(subject.projectId)?.revision ?? 0
      if (liveRevision !== input.expectedPolicyRevision) fail('策略已更新，请重新预览')
      const { record, preview: rebuilt } = resolveCurrentChain(subject, input)
      if (rebuilt.policyRevision !== input.expectedPolicyRevision) fail('策略已更新，请重新预览')
      if (ownerExecutionHash(rebuilt) !== ownerExecutionHash(preview) || value.confirmedFingerprint !== rebuilt.approvalFingerprint || value.confirmedFingerprint !== preview.approvalFingerprint) fail('预览指纹已更新，请重新预览')
      // paused历史行不阻塞同源再发行（撤权→重验证→再发行合法循环）；active幂等由上方分支处理。
      const prior = database.prepare("SELECT * FROM project_owner_execution_grants WHERE project_id=? AND revalidation_id=? AND approval_fingerprint=? AND state='active'").get(subject.projectId, record.id, rebuilt.approvalFingerprint) as Record<string, unknown> | undefined
      if (prior) {
        if ((prior.input_hash as string) !== String(inputHash)) fail('请求ID已用于不同输入')
        saved = rowToGrant(prior)
        return
      }
      const id = `owner-grant-${rebuilt.approvalFingerprint.slice(0, 32)}-${randomUUID().slice(0, 8)}`
      database.prepare(`INSERT INTO project_owner_execution_grants
        (id, project_id, task_id, purpose, state, revalidation_id, revalidation_revision, revalidation_integrity_hash,
         materialization_id, materialization_revision, materialization_integrity_hash, policy_revision,
         executor_employee_id, reviewer_employee_id, workspace_id, channel_id, model_id, runtime, dispatch_mode,
         max_cost_micros, max_runs, max_rework, expires_at, role_budgets_json, approval_fingerprint, source_hash, request_id, input_hash, issued_at)
        VALUES (?,?,?,'owner_business_execution','active',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, subject.projectId, subject.taskId ?? null, record.id, record.revision, record.integrityHash,
        record.source.materialization.id, record.source.materialization.revision, record.source.materialization.integrityHash,
        input.expectedPolicyRevision, rebuilt.executorEmployeeId, rebuilt.reviewerEmployeeId, rebuilt.workspaceId,
        rebuilt.channelId, rebuilt.modelId, rebuilt.runtime, rebuilt.dispatchMode, rebuilt.budget.maxCostMicros, rebuilt.budget.maxRuns,
        rebuilt.budget.maxRework, rebuilt.budget.expiresAt, JSON.stringify(rebuilt.budget.roleBudgetCaps ?? []), rebuilt.approvalFingerprint, rebuilt.sourceHash, input.requestId, String(inputHash), Date.now(),
      )
      saved = rowToGrant(database.prepare('SELECT * FROM project_owner_execution_grants WHERE id=?').get(id) as Record<string, unknown>)
    })()
    if (!saved) fail('事务未保存发行结果')
    return saved
  })
}
function ownerGrantRevokeImpact(grantId: string): { impact: OwnerExecutionGrantRevokePreview['impact']; blockers: string[] } {
  const database = store.getProjectDb()
  const commands = database.prepare("SELECT COUNT(*) AS command_count, SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) AS running_count, SUM(CASE WHEN state='queued' THEN 1 ELSE 0 END) AS queued_count FROM project_owner_execution_commands WHERE grant_id=? AND state!='released'").get(grantId) as { command_count: number; running_count: number | null; queued_count: number | null }
  const pending = database.prepare("SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations r JOIN project_owner_execution_commands c ON c.id=r.command_id WHERE c.grant_id=? AND r.state IN ('reserved','needs_reconcile')").get(grantId) as { count: number }
  const impact = { commandCount: commands.command_count, runningCount: commands.running_count ?? 0, pendingRequestCount: pending.count }
  const blockers = [
    ...(commands.queued_count ? [`有${commands.queued_count}条未启动命令；请先取消并释放队列占额`] : []),
    ...(impact.runningCount ? [`有${impact.runningCount}条运行中命令；请先逐项请求停止，停止未证实前保持unknown`] : []),
    ...(impact.pendingRequestCount ? [`有${impact.pendingRequestCount}条请求占额仍待对账；撤权不会清除占额`] : []),
  ]
  return { impact, blockers }
}
export function previewOwnerExecutionGrantRevoke(rawSubject: unknown, rawRequest: unknown): OwnerExecutionGrantRevokePreview {
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject)
  const value = ownerExecutionObject(rawRequest, ['grantId'])
  if (typeof value.grantId !== 'string' || !value.grantId.trim()) fail('授权ID无效')
  const row = store.getProjectDb().prepare('SELECT * FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(String(value.grantId), subject.projectId) as Record<string, unknown> | undefined
  if (!row) fail('授权不存在或不属于当前主体')
  const grant = rowToGrant(row)
  if (grant.state !== 'active') fail('授权已不在活动状态')
  const { impact, blockers } = ownerGrantRevokeImpact(grant.grantId)
  const fingerprint = ownerExecutionHash({ grantId: grant.grantId, state: grant.state, revalidationId: grant.revalidationId, approvalFingerprint: grant.approvalFingerprint, impact, blockers })
  return { grantId: grant.grantId, projectId: subject.projectId, fingerprint, impact, blockers }
}
export function confirmOwnerExecutionGrantRevoke(rawSubject: unknown, rawRequest: unknown): OwnerExecutionGrant {
  assertLocalActorEnabled()
  const subject = parseOwnerExecutionSubject(rawSubject)
  const value = ownerExecutionObject(rawRequest, ['grantId', 'confirmedFingerprint'])
  if (typeof value.grantId !== 'string' || typeof value.confirmedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.confirmedFingerprint)) fail('撤权请求无效')
  const database = store.getProjectDb()
  if (database.isTransactionActive()) fail('拒绝未提交外层事务')
  return withPolicyLock(() => {
    let saved: OwnerExecutionGrant | null = null
    database.transaction(() => {
      const row = database.prepare('SELECT * FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(String(value.grantId), subject.projectId) as Record<string, unknown> | undefined
      if (!row) fail('授权不存在或不属于当前主体')
      const grant = rowToGrant(row)
      if (grant.state !== 'active') fail('授权已不在活动状态')
      const { impact, blockers } = ownerGrantRevokeImpact(grant.grantId)
      const fingerprint = ownerExecutionHash({ grantId: grant.grantId, state: grant.state, revalidationId: grant.revalidationId, approvalFingerprint: grant.approvalFingerprint, impact, blockers })
      if (fingerprint !== value.confirmedFingerprint) fail('撤权影响面已变化，请重新预览')
      if (blockers.length) fail(`撤权前需收敛未结命令：${blockers.join('；')}`)
      const result = database.prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=? AND state='active'").run(grant.grantId)
      if (result.changes !== 1) fail('撤权状态变更失败，请保留证据核查')
      database.prepare('INSERT INTO project_owner_execution_grant_decisions(grant_id,project_id,action,fingerprint,impact,actor,created_at) VALUES(?,?,?,?,?,?,?)').run(grant.grantId, subject.projectId, 'revoke', fingerprint, JSON.stringify({ commandCount: impact.commandCount, runningCount: impact.runningCount, pendingRequestCount: impact.pendingRequestCount }), 'local-user', Date.now())
      saved = { ...grant, state: 'paused' }
    })()
    if (!saved) fail('事务未保存撤权结果')
    return saved
  })
}
