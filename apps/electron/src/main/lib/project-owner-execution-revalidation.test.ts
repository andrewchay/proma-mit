import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-revalidation-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const prep = await import('./project-owner-execution-preparation')
const materialization = await import('./project-owner-task-materialization')
const policy = await import('./project-pilot-policy')
const grants = await import('./project-pilot-grant-issue')
let service: typeof import('./project-owner-execution-revalidation')
beforeAll(async () => { await store.initProjectDb(); service = await import('./project-owner-execution-revalidation') })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(single = false) {
  const project = store.createProject({ title: 'Owner重验证fixture', description: '' })
  const target = single ? store.createTask(project.id, { title: '保留标题', description: '保留说明' }) : null
  const workspace = createAgentWorkspace(`owner-revalidation-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const executor = employee('执行者'), reviewer = employee('技术评审')
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案' }, target?.id)
  const context = plans.getProjectOwnerPlanningContext(project.id, target?.id)
  const steps = [{ key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: context.sources.roles[0]!.key }, ...(single ? [] : [{ key: 'report', title: '汇总', outcome: '方案', acceptanceCriteria: ['有依据'], dependencies: ['brief'], roleKey: context.sources.roles[0]!.key }])]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '形成方案', assumptions: [], risks: [], steps, changeReason: '建立计划' }, target?.id)
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1, target?.id)
  const subject = { projectId: project.id, ...(target ? { taskId: target.id } : {}) }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step => step.key), executionKind: 'controlled' as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1000000, maxRuns: 2, maxRework: 0, expiresAt: Date.now() + 3600000, changeReason: '暂停准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject, preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const mpv = materialization.previewOwnerTaskMaterialization(subject, materialInput), batch = materialization.materializeOwnerTasks(subject, materialInput, mpv.previewFingerprint)
  const revalidationInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '按真实任务重新冻结' }
  return { project, target, subject, preparation, batch, revalidationInput, executor }
}
function save(f: ReturnType<typeof fixture>) { const pv = service.previewOwnerExecutionRevalidation(f.subject, f.revalidationInput); return service.saveOwnerExecutionRevalidation(f.subject, f.revalidationInput, pv.previewFingerprint) }

test('Given needs_revalidation材料化 When 预览并保存v2 Then 冻结真实Task/dep，v1引用逐字节不变，0任务/Run副作用', () => {
  const f = fixture(), tasksBefore = store.listTasks(f.project.id).length
  const saved = save(f), policyAfter = policy.getPilotPolicy(f.project.id)!
  expect(saved.source.tasks).toHaveLength(2)
  expect(saved.stage).toBe('paused_task_links')
  expect(saved.source.budget.maxCostMicros).toBe(f.preparation.input.maxCostMicros)
  expect(saved.source.budget.expiresAt).toBe(f.preparation.input.expiresAt)
  expect(policyAfter.ownerExecutionRevalidation?.id).toBe(saved.id)
  expect(JSON.stringify(policyAfter.ownerExecutionPreparation)).toBe(JSON.stringify({ schemaVersion: 1, purpose: 'owner_business_execution_preparation', id: f.preparation.id, revision: f.preparation.revision, integrityHash: f.preparation.integrityHash, stage: 'pending_task_links' }))
  expect(store.listTasks(f.project.id)).toHaveLength(tasksBefore)
  expect(service.getOwnerExecutionRevalidation(f.subject).status).toBe('current')
  expect(service.listOwnerExecutionRevalidationHistory(f.subject)).toHaveLength(1)
})
test('Given v2存在 When v1准备视图/材料化视图 Then v1非current，材料化保持needs_revalidation且不开放发行', () => {
  const f = fixture(); save(f)
  const v1 = prep.getOwnerExecutionPreparation(f.subject)
  expect(v1.status).toBe('stale')
  const view = materialization.getOwnerTaskMaterialization(f.subject)
  expect(view.status).toBe('needs_revalidation')
  expect(view.blockers.some(blocker => blocker.includes('v2'))).toBe(true)
  expect(() => grants.previewPilotGrantIssue(f.project.id, policy.getPilotPolicy(f.project.id)!.revision)).toThrow('Owner')
  expect(() => materialization.materializeOwnerTasks(f.subject, { requestId: randomUUID(), expectedMaterializationRevision: 1, expectedPreparationId: f.preparation.id, expectedPreparationRevision: f.preparation.revision, expectedPreparationHash: f.preparation.integrityHash, expectedPolicyRevision: f.preparation.input.expectedPolicyRevision }, 'x'.repeat(64))).toThrow()
})
test('Given 任务描述被普通漂移 When 读取v2 Then stale且记录逐字节不变', () => {
  const f = fixture(), saved = save(f)
  const before = store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_execution_revalidations WHERE id=?').get(saved.id)
  const task = f.target ?? store.listTasks(f.project.id)[0]!
  // paused Owner任务的普通规格写入被store拒绝；漂移只能来自受限外部路径/未来授权修订。
  expect(() => store.updateTask(task.id, { description: '漂移' })).toThrow('Owner')
  store.getProjectDb().prepare('UPDATE tasks SET description=? WHERE id=?').run('漂移', task.id)
  const view = service.getOwnerExecutionRevalidation(f.subject)
  expect(view.status).toBe('stale')
  expect(store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_execution_revalidations WHERE id=?').get(saved.id)).toEqual(before)
})
test('Given 相同请求 When 重试 Then 返回原件不新建；不同输入同ID拒绝', () => {
  const f = fixture(), pv = service.previewOwnerExecutionRevalidation(f.subject, f.revalidationInput), saved = service.saveOwnerExecutionRevalidation(f.subject, f.revalidationInput, pv.previewFingerprint)
  expect(service.saveOwnerExecutionRevalidation(f.subject, f.revalidationInput, pv.previewFingerprint)).toEqual(saved)
  expect(service.listOwnerExecutionRevalidationHistory(f.subject)).toHaveLength(1)
  expect(() => service.saveOwnerExecutionRevalidation(f.subject, { ...f.revalidationInput, changeReason: '不同输入' }, pv.previewFingerprint)).toThrow('请求ID')
})
test('Given 期限已过期或预算字段被改 When 预览/保存 Then 拒绝且不产出v2', () => {
  const f = fixture()
  store.getProjectDb().prepare('UPDATE project_owner_execution_preparations SET payload=replace(payload,?,?) WHERE id=?').run(String(f.preparation.input.expiresAt), String(Date.now() - 1000), f.preparation.id)
  // 原件hash随之失配：材料化视图必须显式stale，v2不产出。
  expect(materialization.getOwnerTaskMaterialization(f.subject).status).toBe('stale')
  expect(() => service.previewOwnerExecutionRevalidation(f.subject, f.revalidationInput)).toThrow()
})
test('Given 外层事务 When 保存v2 Then 拒绝零写入', () => {
  const f = fixture(), pv = service.previewOwnerExecutionRevalidation(f.subject, f.revalidationInput), db = store.getProjectDb()
  db.exec('BEGIN IMMEDIATE')
  try { expect(() => service.saveOwnerExecutionRevalidation(f.subject, f.revalidationInput, pv.previewFingerprint)).toThrow('外层事务') } finally { db.exec('ROLLBACK') }
  expect(service.listOwnerExecutionRevalidationHistory(f.subject)).toHaveLength(0)
})
test('Given policy的v2引用与记录不一致 When 读取 Then 不降级不伪current', () => {
  const f = fixture(); save(f)
  const saved = service.listOwnerExecutionRevalidationHistory(f.subject)[0]!
  store.getProjectDb().prepare('DELETE FROM project_owner_execution_revalidations WHERE id=?').run(saved.id)
  const view = service.getOwnerExecutionRevalidation(f.subject)
  expect(view.status).toBe('stale')
  expect(view.blockers.some(blocker => blocker.includes('悬空'))).toBe(true)
  expect(() => service.previewOwnerExecutionRevalidation(f.subject, f.revalidationInput)).toThrow()
})
test('Given 仅v2/材料化残余证据 When 旧SourceGate消费 Then 全部拒绝不降legacy', async () => {
  const f = fixture(); save(f)
  const db = store.getProjectDb()
  db.prepare('DELETE FROM project_owner_execution_preparations WHERE id=?').run(f.preparation.id)
  db.prepare('DELETE FROM project_owner_task_materializations WHERE id=?').run(f.batch.id)
  db.prepare('DELETE FROM project_owner_task_step_links WHERE materialization_id=?').run(f.batch.id)
  const evidence = await import('./project-owner-execution-preparation-evidence')
  expect(evidence.hasOwnerExecutionPreparationEvidence(f.project.id)).toBe(true)
  expect(() => evidence.assertNoOwnerExecutionPreparation(f.project.id)).toThrow('Owner')
  expect(() => grants.previewPilotGrantIssue(f.project.id, policy.getPilotPolicy(f.project.id)!.revision)).toThrow('Owner')
})
test('Given DB已提交但policy回退未应用 When 读取/重放 Then 显式unapplied，重放与新预览均拒绝且证据保留', () => {
  const f = fixture(), pv = service.previewOwnerExecutionRevalidation(f.subject, f.revalidationInput)
  const saved = service.saveOwnerExecutionRevalidation(f.subject, f.revalidationInput, pv.previewFingerprint)
  // 模拟部分失败：DB已commit，policy JSON的v2引用被回退删除（原件保留）。
  const policyPath = join(directory, 'project-pilot-policies.json')
  const index = JSON.parse(readFileSync(policyPath, 'utf8'))
  index.policies = index.policies.map((item: { projectId: string; ownerExecutionRevalidation?: unknown }) => item.projectId === f.project.id ? (({ ownerExecutionRevalidation: _removed, ...rest }: Record<string, unknown>) => rest)(item) : item)
  writeFileSync(policyPath, JSON.stringify(index))
  const view = service.getOwnerExecutionRevalidation(f.subject)
  expect(view.status).toBe('unapplied')
  expect(view.blockers.some(blocker => blocker.includes('尚未一致应用'))).toBe(true)
  // 与v1同构：unapplied重放显式拒绝，不自动补写JSON；证据保留待核查。
  expect(() => service.saveOwnerExecutionRevalidation(f.subject, f.revalidationInput, pv.previewFingerprint)).toThrow('未一致应用')
  expect(service.listOwnerExecutionRevalidationHistory(f.subject)).toHaveLength(1)
  expect(service.listOwnerExecutionRevalidationHistory(f.subject)[0]).toEqual(saved)
})
test('Given drift修复后重新验证 When 新请求 Then v2历史链式追加，旧记录保留', () => {
  const f = fixture(), saved = save(f)
  const input = { ...f.revalidationInput, requestId: randomUUID(), expectedRevalidationRevision: 1, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, changeReason: '再次确认' }
  const pv = service.previewOwnerExecutionRevalidation(f.subject, input), second = service.saveOwnerExecutionRevalidation(f.subject, input, pv.previewFingerprint)
  expect(second.revision).toBe(2)
  expect(second.previousIntegrityHash).toBe(saved.integrityHash)
  expect(service.listOwnerExecutionRevalidationHistory(f.subject)).toHaveLength(2)
})
