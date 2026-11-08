import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-grant-renewal-')), previous = process.env.PROMA_TEST_CONFIG_DIR
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
const grantIssue = await import('./project-owner-execution-grant-issue')
let renewal: typeof import('./project-owner-execution-grant-renewal')
beforeAll(async () => { await store.initProjectDb(); renewal = await import('./project-owner-execution-grant-renewal') })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

function fixture(grantLifetimeMs = 3600000) {
  const project = store.createProject({ title: 'Owner续期fixture', description: '' })
  const workspace = createAgentWorkspace(`owner-renewal-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: 'glm-5.3-flash', enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'glm-5.3-flash', workspaceIds: [workspace.id] })
  const owner = employee('Owner'), executor = employee('执行者'), reviewer = employee('技术评审')
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案' })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试' })
  management.reconcileOwnerManagement(project.id)
  const delegationInput = { projectId: project.id, requestId: randomUUID(), maxRequests: 6, maxCostMicros: 4_000_000, expiresAt: Date.now() + 6 * 3600000 }
  const delegationPreview = managementDelegation.previewOwnerManagementDelegation(delegationInput)
  const delegation = managementDelegation.confirmOwnerManagementDelegation({ input: delegationInput, previewHash: delegationPreview.previewHash })
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const steps = [{ key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: context.sources.roles[0]!.key }, { key: 'report', title: '汇总', outcome: '方案', acceptanceCriteria: ['有依据'], dependencies: ['brief'], roleKey: context.sources.roles[0]!.key }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '形成方案', assumptions: [], risks: [], steps, changeReason: '建立计划' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const subject = { projectId: project.id }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step => step.key), executionKind: 'controlled' as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [...new Set(steps.map(step => step.roleKey))].map(roleKey => ({ roleKey, employeeId: executor.id })), workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1000000, maxRuns: 2, maxRework: 0, expiresAt: Date.now() + grantLifetimeMs, changeReason: '暂停准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject, preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const mpv = materialization.previewOwnerTaskMaterialization(subject, materialInput), batch = materialization.materializeOwnerTasks(subject, materialInput, mpv.previewFingerprint)
  const revalInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '按真实任务重冻结' }
  const rpv = revalidation.previewOwnerExecutionRevalidation(subject, revalInput), record = revalidation.saveOwnerExecutionRevalidation(subject, revalInput, rpv.previewFingerprint)
  return { project, subject, preparation, batch, record, delegation, executor }
}
function issueAutonomousGrant(f: ReturnType<typeof fixture>) {
  const input = { requestId: randomUUID(), expectedRevalidationRevision: f.record.revision, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, dispatchMode: 'autonomous' as const }
  const preview = grantIssue.previewOwnerExecutionGrantIssue(f.subject, input)
  return grantIssue.confirmOwnerExecutionGrantIssue(f.subject, { input, preview, confirmedFingerprint: preview.approvalFingerprint })
}
function expireGrant(grantId: string) {
  store.getProjectDb().prepare('UPDATE project_owner_execution_grants SET expires_at=? WHERE id=?').run(Date.now() - 1000, grantId)
}
function insertUnsettledCommand(f: ReturnType<typeof fixture>, grantId: string) {
  const taskId = f.batch.links[0]!.taskId, link = f.batch.links[0]!
  const now = Date.now()
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_commands
    (id, project_id, grant_id, idempotency_key, source_task_id, source_step_link_id, source_version, source_hash, employee_id, role, rework_ordinal, reserved_cost_micros, actual_cost_micros, usage_evidence, state, ack_fingerprint, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,'queued',?,?,?)`).run(
    `cmd-${randomUUID()}`, f.project.id, grantId, randomUUID(), taskId, link.id, 1, 'hash', f.executor.id, 'executor', 0, 1000, 'ack', now, now)
}

test('Given 到期自主授权且账本已结算 When 预览并确认续期 Then 原地顺延期限、证据保留、调度恢复ready', () => {
  const f = fixture()
  const issued = issueAutonomousGrant(f)
  expireGrant(issued.grantId)
  const before = grantIssue.getOwnerExecutionGrant(f.subject)!
  const scheduler = require('./project-owner-autonomous-scheduler') as typeof import('./project-owner-autonomous-scheduler')
  expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).state).toBe('expired')
  const expiresAt = Date.now() + 2 * 3600000
  const input = { requestId: randomUUID(), expiresAt }
  const preview = renewal.previewOwnerExecutionGrantRenewal(f.subject, input)
  expect(preview.grantId).toBe(issued.grantId)
  expect(preview.previousExpiresAt).toBe(before.budget.expiresAt)
  expect(preview.expiresAt).toBe(expiresAt)
  expect(preview.budget.maxCostMicros).toBe(before.budget.maxCostMicros)
  expect(preview.budget.maxRuns).toBe(before.budget.maxRuns)
  const renewed = renewal.confirmOwnerExecutionGrantRenewal(f.subject, { input, preview, confirmedFingerprint: preview.renewalFingerprint })
  // 同一授权行原地续期：grant_id 不变，命令/费用账本仍按原授权关联
  expect(renewed.grantId).toBe(issued.grantId)
  expect(renewed.state).toBe('active')
  expect(renewed.budget.expiresAt).toBe(expiresAt)
  expect(renewed.revalidationId).not.toBe(before.revalidationId)
  expect(renewed.budget.maxCostMicros).toBe(before.budget.maxCostMicros)
  expect(renewed.budget.maxRuns).toBe(before.budget.maxRuns)
  expect(renewed.budget.maxRework).toBe(before.budget.maxRework)
  const row = store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grant_decisions WHERE grant_id=? AND action=?').get(issued.grantId, 'renew') as { count: number }
  expect(row.count).toBe(1)
  // 调度器从原授权继续：不再 expired，能按冻结任务推进
  const status = scheduler.getOwnerAutonomousScheduleStatus(f.project.id)
  expect(status.state).toBe('ready')
  expect(status.grantId).toBe(issued.grantId)
  // 再次预览同一期限：已续期后不允许用同一/更早期限重复续期
  expect(() => renewal.previewOwnerExecutionGrantRenewal(f.subject, { requestId: randomUUID(), expiresAt })).toThrow()
})
test('Given 授权未到期 When 请求早于原期限的续期 Then 拒绝', () => {
  const f = fixture()
  const issued = issueAutonomousGrant(f)
  expect(() => renewal.previewOwnerExecutionGrantRenewal(f.subject, { requestId: randomUUID(), expiresAt: issued.budget.expiresAt - 1000 })).toThrow('续期期限须晚于原授权期限')
})
test('Given 授权存在未结算命令 When 预览续期 Then 拒绝', () => {
  const f = fixture()
  const issued = issueAutonomousGrant(f)
  expireGrant(issued.grantId)
  insertUnsettledCommand(f, issued.grantId)
  expect(() => renewal.previewOwnerExecutionGrantRenewal(f.subject, { requestId: randomUUID(), expiresAt: Date.now() + 2 * 3600000 })).toThrow('未结算命令或未知用量')
})
test('Given 预览后授权被并发修改 When 用旧指纹确认 Then 冲突拒绝', () => {
  const f = fixture()
  const issued = issueAutonomousGrant(f)
  expireGrant(issued.grantId)
  const input = { requestId: randomUUID(), expiresAt: Date.now() + 2 * 3600000 }
  const preview = renewal.previewOwnerExecutionGrantRenewal(f.subject, input)
  store.getProjectDb().prepare('UPDATE project_owner_execution_grants SET expires_at=? WHERE id=?').run(Date.now() - 2000, issued.grantId)
  expect(() => renewal.confirmOwnerExecutionGrantRenewal(f.subject, { input, preview, confirmedFingerprint: preview.renewalFingerprint })).toThrow('续期预览已更新')
})
test('Given 非活动授权 When 预览续期 Then 拒绝', () => {
  const f = fixture()
  const issued = issueAutonomousGrant(f)
  store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=?").run(issued.grantId)
  expect(() => renewal.previewOwnerExecutionGrantRenewal(f.subject, { requestId: randomUUID(), expiresAt: Date.now() + 2 * 3600000 })).toThrow('授权已不在活动状态')
})
test('Given 无管理授权绑定 When 预览续期 Then 拒绝', () => {
  const f = fixture()
  const issued = issueAutonomousGrant(f)
  expireGrant(issued.grantId)
  managementDelegation.revokeOwnerManagementDelegation(f.project.id, f.delegation.id)
  expect(() => renewal.previewOwnerExecutionGrantRenewal(f.subject, { requestId: randomUUID(), expiresAt: Date.now() + 2 * 3600000 })).toThrow('项目管理')
})
