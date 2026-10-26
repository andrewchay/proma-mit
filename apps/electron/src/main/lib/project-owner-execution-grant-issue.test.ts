import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-grant-issue-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const management = await import('./project-owner-management-loop')
const managementDelegation = await import('./project-owner-management-delegation')
const plans = await import('./project-owner-plan-service')
const prep = await import('./project-owner-execution-preparation')
const materialization = await import('./project-owner-task-materialization')
const revalidation = await import('./project-owner-execution-revalidation')
const policy = await import('./project-pilot-policy')
const grants = await import('./project-pilot-grant-issue')
const evidence = await import('./project-owner-execution-preparation-evidence')
const { ownerExecutionHash } = await import('./project-owner-execution-source') as { ownerExecutionHash: (v: unknown) => string }
const priceEvidence = await import('./project-pilot-request-evidence')
let service: typeof import('./project-owner-execution-grant-issue')
beforeAll(async () => { await store.initProjectDb(); service = await import('./project-owner-execution-grant-issue') })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(modelId = 'glm-5.3-flash', withRoleBudget = false, withManagementBudget = false) {
  const project = store.createProject({ title: 'Owner发行fixture', description: '' })
  const workspace = createAgentWorkspace(`owner-grant-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('执行者'), reviewer = employee('技术评审')
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案' })
  if (withManagementBudget) {
    const owner = employee('Owner')
    saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试' })
    management.reconcileOwnerManagement(project.id)
    const delegationInput = { projectId: project.id, requestId: randomUUID(), maxRequests: 6, maxCostMicros: 4_000_000, expiresAt: Date.now() + 6 * 3600000 }
    const delegationPreview = managementDelegation.previewOwnerManagementDelegation(delegationInput)
    managementDelegation.confirmOwnerManagementDelegation({ input: delegationInput, previewHash: delegationPreview.previewHash })
  }
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const steps = [{ key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: context.sources.roles[0]!.key }, { key: 'report', title: '汇总', outcome: '方案', acceptanceCriteria: ['有依据'], dependencies: ['brief'], roleKey: context.sources.roles[0]!.key }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '形成方案', assumptions: [], risks: [], steps, changeReason: '建立计划' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const subject = { projectId: project.id }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step => step.key), executionKind: 'controlled' as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [...new Set(steps.map(step => step.roleKey))].map(roleKey => ({ roleKey, employeeId: executor.id })), ...(withRoleBudget ? { roleBudgetCaps: [{ roleKey: steps[0]!.roleKey, maxCostMicros: 400000 }] } : {}), workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1000000, maxRuns: 2, maxRework: 0, expiresAt: Date.now() + 3600000, changeReason: '暂停准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject, preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const mpv = materialization.previewOwnerTaskMaterialization(subject, materialInput), batch = materialization.materializeOwnerTasks(subject, materialInput, mpv.previewFingerprint)
  const revalInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '按真实任务重冻结' }
  const rpv = revalidation.previewOwnerExecutionRevalidation(subject, revalInput), record = revalidation.saveOwnerExecutionRevalidation(subject, revalInput, rpv.previewFingerprint)
  return { project, subject, record, batch, preparation }
}
function issueInput(f: ReturnType<typeof fixture>, dispatchMode: 'manual' | 'autonomous' = 'manual') {
  return { requestId: randomUUID(), expectedRevalidationRevision: f.record.revision, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, dispatchMode }
}
function issue(f: ReturnType<typeof fixture>) {
  const input = issueInput(f), preview = service.previewOwnerExecutionGrantIssue(f.subject, input)
  return service.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: preview.approvalFingerprint })
}

test('Given v2 current+idle+未过期+员工启用 When preview→confirm Then 一行active grant，0命令/执行/会话/请求/Provider/policy JSON写入', () => {
  const f = fixture()
  const before = ['pilot_commands', 'agent_executions', 'pilot_request_reservations'].map(table => (store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)
  const grant = issue(f)
  expect(grant.state).toBe('active')
  expect(grant.budget.expiresAt).toBe(f.preparation.input.expiresAt)
  expect(grant.grantId.startsWith('owner-grant-')).toBe(true)
  expect(['pilot_commands', 'agent_executions', 'pilot_request_reservations'].map(table => (store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)).toEqual(before)
  expect(service.getOwnerExecutionGrant(f.subject)?.state).toBe('active')
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(1)
  // 发行后旧SourceGate七处仍拒（代表性两处）
  expect(() => grants.previewPilotGrantIssue(f.project.id, policy.getPilotPolicy(f.project.id)!.revision)).toThrow('Owner')
  expect(() => materialization.materializeOwnerTasks(f.subject, { requestId: randomUUID(), expectedMaterializationRevision: 1, expectedPreparationId: f.preparation.id, expectedPreparationRevision: f.preparation.revision, expectedPreparationHash: f.preparation.integrityHash, expectedPolicyRevision: f.preparation.input.expectedPolicyRevision }, 'x'.repeat(64))).toThrow()
})
test('Given可选岗位上限 When预览并发行授权 Then授权预算与审批指纹绑定岗位cap且重开可读', async () => {
  const f = fixture('glm-5.3-flash', true), input = issueInput(f), preview = service.previewOwnerExecutionGrantIssue(f.subject, input)
  expect(preview.budget.roleBudgetCaps).toEqual([{ roleKey: f.record.source.tasks[0]!.executor!.roleKey, maxCostMicros: 400000 }])
  const grant = service.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: preview.approvalFingerprint })
  expect(grant.budget.roleBudgetCaps).toEqual(preview.budget.roleBudgetCaps)
  expect(store.getProjectDb().prepare('SELECT role_budgets_json FROM project_owner_execution_grants WHERE id=?').get(grant.grantId)).toEqual({ role_budgets_json: JSON.stringify(preview.budget.roleBudgetCaps) })
  expect(service.getOwnerExecutionGrant(f.subject)?.budget.roleBudgetCaps).toEqual(preview.budget.roleBudgetCaps)
  store.closeProjectDb()
  await store.initProjectDb()
  expect(service.getOwnerExecutionGrant(f.subject)?.budget.roleBudgetCaps).toEqual(preview.budget.roleBudgetCaps)
})
test('GivenDeepSeek Flash渠道与官方审核价格证据 When预览并发行Owner grant Then价格模型精确匹配且仍只创建授权记录', () => {
  const f = fixture('deepseek-flash')
  const grant = issue(f)
  expect(grant).toMatchObject({ state: 'active', modelId: 'deepseek-flash' })
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(1)
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations').get() as { count: number }).count).toBe(0)
})
test('Given模型未匹配审核价格证据 When预览Owner grant Then拒绝且不写入grant', () => {
  const f = fixture('ao06-fake-only-model'), input = issueInput(f)
  expect(() => service.previewOwnerExecutionGrantIssue(f.subject, input)).toThrow(/价格证据|审核模型/)
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(0)
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(0)
})
test('Given preview后审核价格证据模型变化 When confirm Then重新校验拒绝且不写入grant', () => {
  const f = fixture(), input = issueInput(f), preview = service.previewOwnerExecutionGrantIssue(f.subject, input)
  const original = priceEvidence.getPilotReviewedPriceEvidence('zai-glm-5.3-flash-2026-09-28')!
  try {
    priceEvidence.registerPilotPriceEvidenceForTests({ ...original, model: 'changed-reviewed-model' })
    expect(() => service.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: preview.approvalFingerprint })).toThrow()
    expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(0)
  } finally {
    priceEvidence.registerPilotPriceEvidenceForTests(original)
  }
})
test('Given legacy mode omitted or explicit autonomous When preview and confirm Then legacy is manual and mode is fingerprint-bound/persistent', () => {
  const f = fixture('glm-5.3-flash', false, true), legacyInput = { requestId: randomUUID(), expectedRevalidationRevision: f.record.revision, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision }
  const manual = service.previewOwnerExecutionGrantIssue(f.subject, legacyInput)
  const autonomousInput = issueInput(f, 'autonomous')
  const autonomous = service.previewOwnerExecutionGrantIssue(f.subject, autonomousInput)
  expect(manual.dispatchMode).toBe('manual')
  expect(autonomous.dispatchMode).toBe('autonomous')
  expect(autonomous.approvalFingerprint).not.toBe(manual.approvalFingerprint)
  const grant = service.confirmOwnerExecutionGrantIssue(f.subject, { input: autonomousInput, preview: autonomous, confirmedFingerprint: autonomous.approvalFingerprint })
  expect(grant.dispatchMode).toBe('autonomous')
  expect((store.getProjectDb().prepare('SELECT dispatch_mode FROM project_owner_execution_grants WHERE id=?').get(grant.grantId) as { dispatch_mode: string }).dispatch_mode).toBe('autonomous')
})
test('Given active grant When v2重验证preview Then boundary idle拒；撤权后恢复', () => {
  const f = fixture(); issue(f)
  const revalInput = { requestId: randomUUID(), expectedRevalidationRevision: 1, expectedMaterializationId: f.batch.id, expectedMaterializationRevision: f.batch.revision, expectedMaterializationHash: f.batch.integrityHash, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, changeReason: 'blocked' }
  expect(() => revalidation.previewOwnerExecutionRevalidation(f.subject, revalInput)).toThrow('活动授权')
  const grant = service.getOwnerExecutionGrant(f.subject)!
  const revokePreview = service.previewOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId })
  const revoked = service.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId, confirmedFingerprint: revokePreview.fingerprint })
  expect(revoked.state).toBe('paused')
  expect(() => revalidation.previewOwnerExecutionRevalidation(f.subject, revalInput)).not.toThrow()
})
test('Given 同requestId+同指纹重放confirm Then 同一行；不同输入同ID拒', () => {
  const f = fixture(), input = issueInput(f), preview = service.previewOwnerExecutionGrantIssue(f.subject, input)
  const first = service.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: preview.approvalFingerprint })
  expect(service.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: preview.approvalFingerprint })).toEqual(first)
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(1)
  expect(() => service.confirmOwnerExecutionGrantIssue(f.subject, { input: { ...input, requestId: randomUUID() }, preview, confirmedFingerprint: preview.approvalFingerprint })).toThrow()
})
test('Given preview后revision前进或指纹篡改 When confirm Then 拒零写入', () => {
  const f = fixture(), input = issueInput(f), preview = service.previewOwnerExecutionGrantIssue(f.subject, input)
  expect(() => service.confirmOwnerExecutionGrantIssue(f.subject, { input: { ...input, expectedPolicyRevision: input.expectedPolicyRevision + 1 }, preview, confirmedFingerprint: preview.approvalFingerprint })).toThrow()
  expect(() => service.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: 'f'.repeat(64) })).toThrow('指纹')
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(0)
})
test('Given 撤权 When 二次confirm/已paused/错指纹 Then 各自拒绝；paused无复活', () => {
  const f = fixture(), grant = issue(f)
  service.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId, confirmedFingerprint: service.previewOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId }).fingerprint })
  expect(() => service.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId, confirmedFingerprint: service.previewOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId }).fingerprint })).toThrow('活动状态')
  expect(() => service.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId, confirmedFingerprint: 'e'.repeat(64) })).toThrow()
  expect(() => service.confirmOwnerExecutionGrantIssue(f.subject, { input: issueInput(f), preview: service.previewOwnerExecutionGrantIssue(f.subject, issueInput(f)), confirmedFingerprint: service.previewOwnerExecutionGrantIssue(f.subject, issueInput(f)).approvalFingerprint })).not.toThrow()
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(2)
})
test('Given 证据谓词与idle扩展 When 发行/撤权 Then 七路证据恒真、idle随state变化', () => {
  const f = fixture(), grant = issue(f)
  expect(evidence.hasOwnerExecutionPreparationEvidence(f.project.id)).toBe(true)
  expect(() => evidence.assertOwnerExecutionBoundaryIdle(f.project.id)).toThrow('活动授权')
  service.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId, confirmedFingerprint: service.previewOwnerExecutionGrantRevoke(f.subject, { grantId: grant.grantId }).fingerprint })
  expect(evidence.hasOwnerExecutionPreparationEvidence(f.project.id)).toBe(true)
  expect(() => evidence.assertOwnerExecutionBoundaryIdle(f.project.id)).not.toThrow()
})
test('Given 外层事务 When confirm Then 拒绝零写入', () => {
  const f = fixture(), input = issueInput(f), preview = service.previewOwnerExecutionGrantIssue(f.subject, input), db = store.getProjectDb()
  db.exec('BEGIN IMMEDIATE')
  try { expect(() => service.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: preview.approvalFingerprint })).toThrow('外层事务') } finally { db.exec('ROLLBACK') }
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(0)
})
test('Given needs_reconcile When 全路径审计 Then 无写路径（枚举不可达）', () => {
  const f = fixture(); issue(f)
  expect((store.getProjectDb().prepare("SELECT COUNT(*) AS c FROM project_owner_execution_grants WHERE state='needs_reconcile'").get() as { c: number }).c).toBe(0)
})
test('Given 权威库重开 When 读取 Then grant持久且state/引用逐字段保留', async () => {
  const f = fixture(), grant = issue(f)
  store.closeProjectDb(); await store.initProjectDb()
  expect(service.getOwnerExecutionGrant(f.subject)).toEqual(grant)
})

test('Given 本地伪造preview以live+5的policyRevision When confirm Then live CAS拒零写入', () => {
  const f = fixture(), input = issueInput(f)
  const view = revalidation.getOwnerExecutionRevalidation(f.subject), record = view.revalidation!
  const sourceHash = ownerExecutionHash(record.source)
  const forgedInput = { ...input, expectedPolicyRevision: input.expectedPolicyRevision + 5 }
  // 本地重算指纹（镜像审查探针）：确认阶段live CAS必须独立拦截。
  const approvalFingerprint = service.hashOwnerGrantApproval({ subject: f.subject, revalidation: { id: record.id, revision: record.revision, integrityHash: record.integrityHash }, sourceHash, policyRevision: forgedInput.expectedPolicyRevision, executorEmployeeId: record.source.executor.id, reviewerEmployeeId: record.source.reviewer.id, workspaceId: record.source.workspaceId, channelId: record.source.channelId, modelId: record.source.modelId, runtime: record.source.runtime, budget: { ...record.source.budget } })
  const forgedPreview = { ...f.subject, policyRevision: forgedInput.expectedPolicyRevision, revalidationId: record.id, revalidationRevision: record.revision, revalidationIntegrityHash: record.integrityHash, materializationId: record.source.materialization.id, materializationRevision: record.source.materialization.revision, materializationIntegrityHash: record.source.materialization.integrityHash, sourceHash, executorEmployeeId: record.source.executor.id, reviewerEmployeeId: record.source.reviewer.id, workspaceId: record.source.workspaceId, channelId: record.source.channelId, modelId: record.source.modelId, runtime: record.source.runtime, budget: { ...record.source.budget }, blockers: [], approvalFingerprint }
  expect(() => service.confirmOwnerExecutionGrantIssue(f.subject, { input: forgedInput, preview: forgedPreview, confirmedFingerprint: approvalFingerprint })).toThrow('策略已更新')
  expect(service.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(0)
})
test('Given 病态删除其余五族证据仅留grant行 When 旧issuer Then 第7路兜底仍拒', async () => {
  const f = fixture(), grant = issue(f), db = store.getProjectDb()
  db.prepare('DELETE FROM project_owner_execution_preparations WHERE id=?').run(f.preparation.id)
  db.prepare('DELETE FROM project_owner_task_materializations WHERE id=?').run(f.batch.id)
  db.prepare('DELETE FROM project_owner_execution_revalidations WHERE id=?').run(f.record.id)
  expect(evidence.hasOwnerExecutionPreparationEvidence(f.project.id)).toBe(true)
  expect(() => evidence.assertNoOwnerExecutionPreparation(f.project.id)).toThrow('Owner')
  expect(() => grants.previewPilotGrantIssue(f.project.id, policy.getPilotPolicy(f.project.id)!.revision)).toThrow('Owner')
  void grant
})

test('Given 过期needs_reconcile grant When 双阶段归档 Then 只归档grant并保留未知命令占额', async () => {
  const archive = await import('./project-owner-execution-expiry-archive')
  const f = fixture('glm-5.3-flash', false, true), db = store.getProjectDb(), now = Date.now()
  const autonomousInput = issueInput(f, 'autonomous'), grantPreview = service.previewOwnerExecutionGrantIssue(f.subject, autonomousInput)
  const grant = service.confirmOwnerExecutionGrantIssue(f.subject, { input: autonomousInput, preview: grantPreview, confirmedFingerprint: grantPreview.approvalFingerprint })
  const task = db.prepare('SELECT id, owner_step_link_id FROM tasks WHERE project_id=? AND owner_step_link_id IS NOT NULL ORDER BY created_at LIMIT 1').get(f.project.id) as { id: string; owner_step_link_id: string }
  const commandId = randomUUID(), runId = randomUUID(), receiptHash = 'a'.repeat(64), nowCreated = now - 10
  db.prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile', expires_at=? WHERE id=?").run(now - 1, grant.grantId)
  db.prepare(`INSERT INTO project_owner_execution_commands
    (id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,employee_id,role,rework_ordinal,
     reserved_cost_micros,actual_cost_micros,usage_evidence,usage_record_key,state,execution_id,ack_fingerprint,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,0,166667,NULL,NULL,NULL,'needs_reconcile',NULL,?,?,?)`).run(
      commandId, f.project.id, grant.grantId, randomUUID(), task.id, task.owner_step_link_id, grant.revalidationRevision,
      'source-hash', grant.executorEmployeeId, 'executor', 'f'.repeat(64), nowCreated, nowCreated,
    )
  const input = { projectId: f.project.id, grantId: grant.grantId, runId, receiptSha256: receiptHash }
  const preview = archive.previewExpiredOwnerExecutionGrantArchive(input)
  expect(preview).toMatchObject({ grantId: grant.grantId, expiresAt: now - 1, reservedCostMicros: 166667, actualCostMicros: null, budgetReleasedMicros: 0 })
  expect(() => archive.confirmExpiredOwnerExecutionGrantArchive({ ...input, expectedFingerprint: '0'.repeat(64) })).toThrow()
  const result = archive.confirmExpiredOwnerExecutionGrantArchive({ ...input, expectedFingerprint: preview.fingerprint })
  expect(result).toMatchObject({ state: 'archived', grantId: grant.grantId, fingerprint: preview.fingerprint })
  expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(grant.grantId)).toEqual({ state: 'archived' })
  expect(db.prepare('SELECT state, reserved_cost_micros, actual_cost_micros, usage_evidence FROM project_owner_execution_commands WHERE id=?').get(commandId)).toEqual({ state: 'needs_reconcile', reserved_cost_micros: 166667, actual_cost_micros: null, usage_evidence: null })
  const decisions = db.prepare("SELECT action, fingerprint, actor, impact FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action='reconcile'").all(grant.grantId) as Array<{ action: string; fingerprint: string; actor: string; impact: string }>
  expect(decisions).toHaveLength(1)
  expect(decisions[0]).toMatchObject({ action: 'reconcile', fingerprint: preview.fingerprint, actor: 'local-user' })
  expect(JSON.parse(decisions[0]!.impact)).toMatchObject({ reason: 'expired_grant_archive', receiptSha256: receiptHash, reservedCostMicros: 166667, actualCostMicros: null, budgetReleasedMicros: 0 })
  expect(() => evidence.assertOwnerExecutionBoundaryIdle(f.project.id)).toThrow('未决占额')
  const scheduler = await import('./project-owner-autonomous-scheduler')
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).state).toBe('archived')
  expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(grant.grantId)).toEqual({ count: 1 })
  expect(archive.confirmExpiredOwnerExecutionGrantArchive({ ...input, expectedFingerprint: preview.fingerprint })).toMatchObject({ state: 'archived', alreadyArchived: true, fingerprint: preview.fingerprint })
  expect(() => archive.confirmExpiredOwnerExecutionGrantArchive({ ...input, runId: randomUUID(), receiptSha256: 'a'.repeat(64), expectedFingerprint: preview.fingerprint })).toThrow(/重放证据/)
  expect(db.prepare("SELECT COUNT(*) AS count FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action='reconcile'").get(grant.grantId)).toEqual({ count: 1 })
})

test('Given 有效期内/运行命令/未解决停止升级 When 预览过期归档 Then 拒绝且不写审计', async () => {
  const archive = await import('./project-owner-execution-expiry-archive')
  const f = fixture(), grant = issue(f), db = store.getProjectDb(), commandId = randomUUID(), now = Date.now()
  db.prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile', expires_at=? WHERE id=?").run(now + 60000, grant.grantId)
  const task = db.prepare('SELECT id, owner_step_link_id FROM tasks WHERE project_id=? ORDER BY created_at LIMIT 1').get(f.project.id) as { id: string; owner_step_link_id: string }
  const createdAt = now
  db.prepare(`INSERT INTO project_owner_execution_commands
    (id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,employee_id,role,rework_ordinal,
     reserved_cost_micros,state,execution_id,ack_fingerprint,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,0,166667,'running',NULL,?,?,?)`).run(
      commandId, f.project.id, grant.grantId, randomUUID(), task.id, task.owner_step_link_id, grant.revalidationRevision,
      'source-hash', grant.executorEmployeeId, 'executor', 'f'.repeat(64), createdAt, createdAt,
    )
  const input = { projectId: f.project.id, grantId: grant.grantId, runId: randomUUID(), receiptSha256: 'b'.repeat(64) }
  expect(() => archive.previewExpiredOwnerExecutionGrantArchive(input)).toThrow(/过期/)
  db.prepare('UPDATE project_owner_execution_grants SET expires_at=? WHERE id=?').run(Date.now() - 1, grant.grantId)
  expect(() => archive.previewExpiredOwnerExecutionGrantArchive(input)).toThrow(/运行|排队/)
  const stoppedExecutionId = randomUUID()
  db.prepare("UPDATE project_owner_execution_commands SET state='needs_reconcile', execution_id=? WHERE id=?").run(stoppedExecutionId, commandId)
  db.prepare(`INSERT INTO project_owner_execution_stop_escalations
    (escalation_id,execution_id,command_id,project_id,session_id,requested_at,reason,resolved_at)
    VALUES(?,?,?,?,?,?,?,NULL)`).run(randomUUID(), stoppedExecutionId, commandId, f.project.id, randomUUID(), now, 'user_requested_stop')
  expect(() => archive.previewExpiredOwnerExecutionGrantArchive(input)).toThrow(/停止升级/)
  expect(db.prepare("SELECT state FROM project_owner_execution_grants WHERE id=?").get(grant.grantId)).toEqual({ state: 'needs_reconcile' })
  expect(db.prepare("SELECT COUNT(*) AS count FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action='reconcile'").get(grant.grantId)).toEqual({ count: 0 })
})

test('Given旧grant表没有archived状态 When重开数据库 Then迁移保留行并接受终态归档', async () => {
  const f = fixture(), grant = issue(f), db = store.getProjectDb()
  db.prepare("DELETE FROM project_owner_execution_grant_decisions WHERE action='reconcile'").run()
  db.prepare("DELETE FROM project_owner_execution_grants WHERE state='archived'").run()
  const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_owner_execution_grants'").get() as { sql: string }).sql
  const legacySchema = schema.replace("CHECK (state IN ('active', 'paused', 'needs_reconcile', 'archived'))", "CHECK (state IN ('active', 'paused', 'needs_reconcile'))").replace("    role_budgets_json TEXT NOT NULL DEFAULT '[]',\n", '')
  expect(legacySchema).not.toBe(schema)
  expect(legacySchema).not.toContain('role_budgets_json')
  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_owner_grants_single_active')
    db.exec('DROP INDEX IF EXISTS idx_owner_grants_project')
    db.exec('DROP INDEX IF EXISTS idx_owner_grants_revalidation')
    db.exec('ALTER TABLE project_owner_execution_grants RENAME TO project_owner_execution_grants_legacy')
    db.exec(legacySchema)
    const columns = (db.prepare('PRAGMA table_info(project_owner_execution_grants)').all() as Array<{ name: string }>).map(row => row.name)
    const names = columns.join(',')
    db.exec(`INSERT INTO project_owner_execution_grants (${names}) SELECT ${names} FROM project_owner_execution_grants_legacy`)
    db.exec('DROP TABLE project_owner_execution_grants_legacy')
  })()
  store.closeProjectDb(); await store.initProjectDb()
  const migrated = store.getProjectDb()
  expect(migrated.prepare('SELECT state, approval_fingerprint, role_budgets_json FROM project_owner_execution_grants WHERE id=?').get(grant.grantId)).toMatchObject({ state: 'active', approval_fingerprint: grant.approvalFingerprint, role_budgets_json: JSON.stringify(grant.budget.roleBudgetCaps ?? []) })
  expect(migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_owner_execution_grants'").get()).toMatchObject({ sql: expect.stringContaining('archived') })
  const indexes = (migrated.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_owner_grants_%'").all() as Array<{ name: string }>).map(row => row.name)
  expect(indexes).toContain('idx_owner_grants_single_active')
  expect(indexes).toContain('idx_owner_grants_project')
  expect(indexes).toContain('idx_owner_grants_revalidation')
  expect(() => migrated.prepare("UPDATE project_owner_execution_grants SET state='archived' WHERE id=?").run(grant.grantId)).not.toThrow()
})
