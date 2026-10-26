import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-admission-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
let encrypted = false
const electron = { ...buildElectronMock(), safeStorage: { isEncryptionAvailable: () => encrypted, encryptString: (value: string) => Buffer.from(value, 'utf8'), decryptString: (value: Buffer) => value.toString('utf8') } }
mock.module('electron', () => electron)
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const { ownerPlanningAdmissionHash } = await import('./project-owner-planning-provider')
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const service = await import('./project-owner-runtime-binding')
const source = await import('./project-owner-planning-source')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(provider: 'openai' | 'anthropic' | 'google' = 'openai', baseUrl = 'https://example.invalid') {
  const project = store.createProject({ title: 'Owner定位', description: '' })
  const workspace = createAgentWorkspace(`Owner-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假渠道', provider, baseUrl, apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: '执行载体', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const binding = { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '明确绑定既有载体' }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '提出可评审的定位建议' })
  return { project, employee, workspace, channel, binding }
}
function request(projectId: string, bindingRevision = 1) { const context = getProjectOwnerPlanningContext(projectId); return { requestId: randomUUID(), expectedBindingRevision: bindingRevision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint } }
function prepared(provider: 'openai' | 'anthropic' | 'google' = 'openai', baseUrl?: string) { const f = fixture(provider, baseUrl); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const link = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); return { ...f, link } }
const runService = await import('./project-owner-planning-run-service')
const { getProjectOwnerPlanDraft } = await import('./project-owner-plan-service')
const controlled = await import('./controlled-project-task-service')
const registry = await import('./agent-headless-runner-registry')
const assert = spyOn(controlled, 'assertControlledPreparedExecution').mockImplementation(() => {})
const claim = spyOn(controlled, 'claimControlledPreparedExecution').mockImplementation(executionId => { store.updateAgentExecution(executionId, { status: 'running' }) })
// 显式假授权与认领仅为真实Worker callback走查，不验证收费start门禁或Provider。A门禁仍由独立真实用例保留。
afterAll(() => { assert.mockRestore(); claim.mockRestore() })
async function launch() {
  const f = prepared(); store.updateTask(f.link.planningTaskId, { status: 'pending' })
  const executionId = employees.enqueueControlledPreparedTask(f.link.planningTaskId)
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, f.link.planningTaskId)
  let callbacks!: import('./agent-headless-runner-registry').HeadlessAgentRunCallbacks
  registry.setHeadlessAgentRunner(async (_input, received) => { callbacks = received })
  expect(await employees.tryStartExecution(executionId)).toBe(true)
  const execution = store.getAgentExecution(executionId)!, frozen = source.readOwnerPlanningSnapshot(f.link.planningTaskId)!
  store.getProjectDb().prepare('INSERT INTO project_owner_planning_admissions (link_id, execution_id, session_id, request_hash, source_snapshot, admitted_at) VALUES (?, ?, ?, ?, ?, ?)').run(f.link.id, executionId, execution.sessionId, 'a'.repeat(64), JSON.stringify(frozen.context), Date.now())
  const admission = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_admissions WHERE execution_id=?').get(executionId) as import('./project-owner-planning-provider').OwnerPlanningAdmission
  store.getProjectDb().prepare('UPDATE project_owner_planning_admissions SET integrity_hash=? WHERE execution_id=?').run(ownerPlanningAdmissionHash(admission), admission.execution_id)
  const result = { type: 'result' as const, subtype: 'success' as const, session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify({ schemaVersion: 1, kind: 'plan_proposal', projectId: f.project.id, goalVersion: 1, contextFingerprint: f.link.contextFingerprint, proposal: { summary: '规划成果', assumptions: [], risks: [], steps: [{ key: 'brief', title: '研究定位', outcome: '定位简报', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: frozen.context.sources.roles[0]!.key }] } }), usage: { input_tokens: 0, output_tokens: 0 } }
  return { ...f, executionId, callbacks, result }
}
test('Given 真实Worker与假RunnerSDK终态 When 回调完成 Then 生成待审Plan而不取普通摘要/员工绩效/learning/业务完成', async () => {
  const f = await launch(), before = store.getAgentEmployee(f.employee.id)!
  f.callbacks.onComplete([], { runtimeResult: f.result })
  expect(getProjectOwnerPlanDraft(f.project.id)).toMatchObject({ origin: 'generated', state: 'proposed' }); expect(store.getTask(f.link.planningTaskId)?.status).toBe('paused'); expect(store.getAgentEmployee(f.employee.id)?.completedTasks).toBe(before.completedTasks)
  expect(store.listAgentEmployeeLearningSamples(f.employee.id)).toHaveLength(0)
  f.callbacks.onError('重复错误'); f.callbacks.onComplete([], {})
  expect(getProjectOwnerPlanDraft(f.project.id)?.revision).toBe(1); expect(runService.getOwnerPlanningRunOutcome(f.executionId)?.state).toBe('proposed')
})
test('Given 已发OwnerRun失联 When 心跳 Then unknown/stale，原占位不删，不进入普通重试/learning', async () => {
  const f = await launch(); employees.scanAgentEmployeeHeartbeat(); expect(store.getAgentExecution(f.executionId)?.status).toBe('stale'); expect(runService.getOwnerPlanningRunOutcome(f.executionId)?.state).toBe('unknown'); expect(store.listAgentEmployeeLearningSamples(f.employee.id)).toHaveLength(0)
  f.callbacks.onComplete([], { runtimeResult: { ...f.result, total_cost_usd: 0.25 } }); expect(getProjectOwnerPlanDraft(f.project.id)).toBeNull(); expect((store.getProjectDb().prepare('SELECT id FROM project_owner_planning_run_receipts WHERE execution_id = ?').all(f.executionId) as { id: string }[])).toHaveLength(2)
})
test('Given Owner stop请求仅接受未证终止 When 晚到成功 Then 意图持久阻止生成，费用证据可保留', async () => {
  const f = await launch(); registry.setAgentStopper((sessionId, expectedGeneration) => ({ sessionId, expectedGeneration, activeGeneration: expectedGeneration, requestAccepted: true, stopped: false, processTermination: 'NOT_VERIFIED', reason: 'stop-request-accepted' }))
  expect(employees.cancelAgentExecution(f.executionId)).toMatchObject({ stopRequested: true, stopped: false, processTermination: 'NOT_VERIFIED' }); expect(store.getAgentExecution(f.executionId)?.status).toBe('running')
  f.callbacks.onComplete([], { runtimeResult: f.result }); expect(runService.getOwnerPlanningRunOutcome(f.executionId)?.state).toBe('stopped'); expect(getProjectOwnerPlanDraft(f.project.id)).toBeNull(); expect(store.listAgentEmployeeLearningSamples(f.employee.id)).toHaveLength(0)
})
test('Given Owner资料损坏但已运行 When 用户停止 Then 仍向既定generation发abort，不因来源错误禁止停止', async () => {
  const f = await launch(); let stopped = 0; registry.setAgentStopper((sessionId, expectedGeneration) => { stopped++; return { sessionId, expectedGeneration, activeGeneration: expectedGeneration, requestAccepted: true, stopped: true, processTermination: 'VERIFIED', reason: 'stop-request-accepted' } })
  store.getProjectDb().prepare("UPDATE project_owner_planning_links SET source_snapshot = '{}' WHERE id = ?").run(f.link.id)
  expect(employees.cancelAgentExecution(f.executionId)).toMatchObject({ status: 'cancelled', stopped: true }); expect(stopped).toBe(1); expect(store.getAgentExecution(f.executionId)?.error).toContain('费用仍未知')
})
test('Given 当前Owner来源损坏 When callback Then 原始SDK证据先隔离、执行stale，不回普通DoD/学习；修复后晚到不生成', async () => {
  const f = await launch(); const row = store.getProjectDb().prepare('SELECT source_snapshot FROM project_owner_planning_links WHERE id = ?').get(f.link.id) as { source_snapshot: string }; store.getProjectDb().prepare("UPDATE project_owner_planning_links SET source_snapshot = '{}' WHERE id = ?").run(f.link.id)
  f.callbacks.onComplete([], { runtimeResult: { ...f.result, total_cost_usd: 0.6 } }); expect(store.getAgentExecution(f.executionId)?.status).toBe('stale'); expect(store.listAgentEmployeeLearningSamples(f.employee.id)).toHaveLength(0)
  store.getProjectDb().prepare('UPDATE project_owner_planning_links SET source_snapshot = ? WHERE id = ?').run(row.source_snapshot, f.link.id); f.callbacks.onComplete([], { runtimeResult: f.result }); expect(getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 只剩stop/callback/receipt/outcome/admission任一Owner证据 When 回调/删除 Then 不降级普通Owner失败学习或抹证据', async () => {
  for (const evidence of ['stop', 'callback', 'receipt', 'outcome', 'admission']) {
    const f = await launch(), db = store.getProjectDb()
    if (evidence === 'stop') db.prepare('INSERT INTO project_owner_planning_stop_requests (execution_id,session_id,requested_at) VALUES (?,?,?)').run(f.executionId,f.result.session_id,Date.now())
    if (evidence === 'callback') db.prepare('INSERT INTO project_owner_planning_callback_evidence (id,execution_id,payload) VALUES (?,?,?)').run(randomUUID(),f.executionId,'{}')
    if (evidence === 'receipt') db.prepare('INSERT INTO project_owner_planning_run_receipts (id,execution_id,capture_hash,payload) VALUES (?,?,?,?)').run(randomUUID(),f.executionId,'b'.repeat(64),'{}')
    if (evidence === 'outcome') db.prepare('INSERT INTO project_owner_planning_run_outcomes (execution_id,receipt_id,payload) VALUES (?,?,?)').run(f.executionId,randomUUID(),'{}')
    if (evidence !== 'admission') db.prepare('DELETE FROM project_owner_planning_admissions WHERE execution_id=?').run(f.executionId)
    db.prepare('DELETE FROM project_owner_planning_links WHERE id=?').run(f.link.id);db.prepare('UPDATE controlled_task_preparations SET owner_planning_link_id=NULL WHERE task_id=?').run(f.link.planningTaskId)
    expect(runService.ownerPlanningPurposeExists(f.link.planningTaskId,f.executionId)).toBe(true); expect(() => source.readOwnerPlanningSnapshot(f.link.planningTaskId)).toThrow('Owner')
    expect(() => store.deleteTask(f.link.planningTaskId)).toThrow('Owner'); expect(() => store.deleteProject(f.project.id)).toThrow('Owner')
    f.callbacks.onError('来源损坏后的error'); f.callbacks.onComplete([], { runtimeResult: f.result }); employees.scanAgentEmployeeHeartbeat()
    expect(store.getAgentExecution(f.executionId)?.status).toBe('stale');expect(store.listAgentEmployeeLearningSamples(f.employee.id)).toHaveLength(0)
  }
})
