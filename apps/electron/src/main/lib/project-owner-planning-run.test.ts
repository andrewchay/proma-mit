import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
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
function running(f: ReturnType<typeof prepared>) {
  const sessionId = randomUUID(), executionId = randomUUID()
  store.createAgentExecution({ id: executionId, projectId: f.project.id, entityType: 'task', entityId: f.link.planningTaskId, agentId: f.employee.id, sessionId, status: 'running', prompt: '不能信任此角色原文' })
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, f.link.planningTaskId)
  return { executionId, sessionId }
}
const runService = await import('./project-owner-planning-run-service')
const plans = await import('./project-owner-plan-service')
function accepted(f: ReturnType<typeof prepared>) {
  const run = running(f); const snapshot = source.readOwnerPlanningSnapshot(f.link.planningTaskId)!;
  // 只测试可信callback/生成链：显式假占位，不冒充真实费用授权或HTTP。
  store.getProjectDb().prepare('INSERT INTO project_owner_planning_admissions (link_id, execution_id, session_id, request_hash, source_snapshot, admitted_at) VALUES (?, ?, ?, ?, ?, ?)').run(f.link.id, run.executionId, run.sessionId, 'a'.repeat(64), JSON.stringify(snapshot.context), Date.now())
  const admission = store.getProjectDb().prepare('SELECT * FROM project_owner_planning_admissions WHERE execution_id=?').get(run.executionId) as import('./project-owner-planning-provider').OwnerPlanningAdmission
  store.getProjectDb().prepare('UPDATE project_owner_planning_admissions SET integrity_hash=? WHERE execution_id=?').run(ownerPlanningAdmissionHash(admission), admission.execution_id)
  const response = { schemaVersion: 1, kind: 'plan_proposal', projectId: f.project.id, goalVersion: snapshot.link.goalVersion, contextFingerprint: snapshot.context.fingerprint, proposal: { summary: '生成定位简报', assumptions: [], risks: [], steps: [{ key: 'brief', title: '定位研究', outcome: '定位简报', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: snapshot.context.sources.roles[0]!.key }] } }
  const result = { type: 'result' as const, subtype: 'success' as const, session_id: run.sessionId, result: JSON.stringify(response), finish_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 }, owner_planning_usage: { inputTokens: null, outputTokens: 4, cacheReadTokens: null, cacheWriteTokens: null } }
  return { ...f, ...run, response, result }
}
test('Given 可信Run When 完成 Then 先存原文/unknown费用，再generated proposed，不触业务DoD；重复幂等', () => {
  const f = accepted(prepared()); const before = store.listTasks(f.project.id).length
  const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)!
  expect(outcome.state).toBe('proposed'); const receipt = runService.getOwnerPlanningRunReceipt(outcome.receiptId)!; expect(receipt).toMatchObject({ responseText: f.result.result, cost: { source: 'unknown', usd: null }, usage: { inputTokens: null, outputTokens: 4 } })
  expect(plans.getProjectOwnerPlanDraft(f.project.id)).toMatchObject({ state: 'proposed', actor: 'system:owner-planner', origin: 'generated', sourceRun: { executionId: f.executionId } }); expect(store.getTask(f.link.planningTaskId)?.status).toBe('paused'); expect(store.listTasks(f.project.id)).toHaveLength(before)
  expect(runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)).toEqual(outcome); expect(plans.listProjectOwnerPlanHistory(f.project.id)).toHaveLength(1)
})
test('Given generated提案 When 人工确认 Then local-user确认，不能客户端伪造origin或Run', () => {
  const f = accepted(prepared()); runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)
  expect(plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 1)).toMatchObject({ state: 'confirmed', actor: 'local-user', origin: 'generated' }); expect(plans.listProjectOwnerPlanHistory(f.project.id)).toHaveLength(2)
  expect(() => plans.saveProjectOwnerPlanDraft(f.project.id, 1, 2, { ...f.response.proposal, origin: 'generated', changeReason: '伪造', expectedContextFingerprint: f.link.contextFingerprint })).toThrow('未知字段')
})
test('Given 来源或Plan期间变化 When 晚到终态 Then 原文/真实USD保存，不覆盖新内容', () => {
  const f = accepted(prepared()); saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '新的定位目标' })
  const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, total_cost_usd: 0.12 })!; expect(outcome.state).toBe('stale'); expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)?.cost).toEqual({ source: 'runtime_reported', usd: 0.12 }); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 取消/网络unknown后晚到 When 返回原文token费用 Then 新证据不丢但不重新生成', () => {
  const f = accepted(prepared()); const first = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', undefined, true)!
  expect(first.state).toBe('stopped'); expect(runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, total_cost_usd: 0.2 })).toEqual(first)
  const rows = store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_run_receipts WHERE execution_id = ?').all(f.executionId) as { payload: string }[]; expect(rows).toHaveLength(2); expect(JSON.parse(rows[1]!.payload).cost.usd).toBe(0.2); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 澄清 When 完成 Then 人答前无提案或补请求', () => {
  const f = accepted(prepared()); const { proposal: _proposal, ...binding } = f.response; const response = { ...binding, kind: 'needs_clarification', reason: '验收范围影响结果', questions: [{ key: 'audience', question: '核心受众是谁？', why: '决定定位范围', options: [] }] }
  const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, result: JSON.stringify(response) })!; expect(outcome.state).toBe('needs_clarification'); expect(outcome.clarification?.questions).toHaveLength(1); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 无占位/错session/非stop/坏JSON When callback Then 不生成；费用不从兼容usage估算', () => {
  for (const variation of ['no_admission', 'wrong_session', 'length', 'bad_json']) {
    const f = accepted(prepared()); if (variation === 'no_admission') store.getProjectDb().prepare('DELETE FROM project_owner_planning_admissions WHERE execution_id = ?').run(f.executionId)
    const result = { ...f.result, ...(variation === 'wrong_session' ? { session_id: 'wrong' } : variation === 'length' ? { finish_reason: 'length', subtype: 'error_during_execution' as const } : variation === 'bad_json' ? { result: 'not json' } : {}) }
    const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', result)!; expect(outcome.state).not.toBe('proposed'); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull(); expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)?.cost.source).toBe('unknown')
  }
})
test('Given 回执或origin数据被改 When 历史读取 Then fail closed而非信任generated标签', () => {
  const f = accepted(prepared()); const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)!
  store.getProjectDb().prepare("UPDATE project_owner_planning_run_receipts SET payload = '{}' WHERE id = ?").run(outcome.receiptId)
  expect(() => plans.getProjectOwnerPlanDraft(f.project.id)).toThrow('计划记录格式无效')
})
test('Given 无效JSON不是版本过时 When parser拒绝 Then failed而非stale，原文仍在', () => {
  const f = accepted(prepared()); const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, result: 'invalid-json' })!; expect(outcome.state).toBe('failed'); expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)?.responseText).toBe('invalid-json')
})
test('Given 失联stale后晚到可信响应 When 内部生成函数被直接调用 Then 不绕过终态Run限制', () => {
  const f = accepted(prepared()); store.updateAgentExecution(f.executionId, { status: 'stale' }); const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)!
  expect(() => plans.appendGeneratedOwnerPlan(outcome.receiptId)).toThrow('运行中'); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given Model期间已有新人工Plan When 返回 Then 双CAS保护新人工内容，原始Run仍保存', () => {
  const f = accepted(prepared()); plans.saveProjectOwnerPlanDraft(f.project.id, 1, 0, { expectedContextFingerprint: f.link.contextFingerprint, ...f.response.proposal, summary: '更新的人工作法', changeReason: '人工取舍变更' })
  expect(runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)?.state).toBe('stale'); expect(plans.getProjectOwnerPlanDraft(f.project.id)?.proposal.summary).toBe('更新的人工作法')
})
test('Given 载体绑定新revision When 旧Run晚到 Then 以冻结旧绑定存原文/已报告0USD但不覆盖Plan', () => {
  const f = accepted(prepared()); service.saveOwnerRuntimeBinding(f.project.id, 1, { ...f.binding, ownerName: '新的项目Owner名称', changeReason: '配置已变' })
  const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, total_cost_usd: 0 })!; expect(outcome.state).toBe('stale'); expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)).toMatchObject({ bindingRevision: 1, cost: { source: 'runtime_reported', usd: 0 } }); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 当前处理事务失败 When Run回调 Then receipt先提交保留，Plan/outcome回滚且不释放admission', () => {
  const f = accepted(prepared()); store.getProjectDb().exec("CREATE TRIGGER owner_outcome_failure BEFORE INSERT ON project_owner_planning_run_outcomes BEGIN SELECT RAISE(ABORT, 'fake outcome failure'); END")
  try { expect(() => runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)).toThrow('fake outcome failure'); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull(); expect(runService.getOwnerPlanningRunOutcome(f.executionId)).toBeNull(); expect((store.getProjectDb().prepare('SELECT id FROM project_owner_planning_run_receipts WHERE execution_id = ?').all(f.executionId) as { id: string }[])).toHaveLength(1) } finally { store.getProjectDb().exec('DROP TRIGGER owner_outcome_failure') }
  expect(runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)?.state).toBe('proposed')
})
test('Given 已排队但session建立前失败 When 可信启动错误回调 Then 原用途仍可留unknown费用失败回执，不卡在queued', () => {
  const f = prepared(); const executionId = randomUUID(); store.createAgentExecution({ id: executionId, projectId: f.project.id, entityType: 'task', entityId: f.link.planningTaskId, agentId: f.employee.id, sessionId: '', status: 'queued', prompt: '' }); store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, f.link.planningTaskId)
  expect(runService.recordOwnerPlanningRun(executionId, 'unknown', undefined, false, 'session创建失败')?.state).toBe('failed'); expect(store.getAgentExecution(executionId)?.status).toBe('failed')
})
test('Given paused Owner准备 When 只读预检 Then 显示实际用途/全JSON资料/单请求未知成本，预检本身不授权启动', async () => {
  const f = prepared(); const { getControlledTaskStartPreview, startControlledTask } = await import('./controlled-project-task-service'); const preview = getControlledTaskStartPreview(f.link.planningTaskId)
  expect(preview.ownerPlanning).toMatchObject({ purpose: 'owner_planning', ownerName: f.binding.ownerName, bindingRevision: 1, goalRevision: 1, planRevision: 0, maxRequests: 1, maxOutputTokens: 4096, costs: 'unknown_no_hard_cap', context: { fingerprint: f.link.contextFingerprint } }); expect(preview.modelId).toBe(f.employee.modelId!)
  await expect(startControlledTask({ taskId: f.link.planningTaskId, previewHash: preview.previewHash, acknowledgeModelCosts: false })).rejects.toThrow('费用'); expect(store.listAgentExecutionsByEntity('task', f.link.planningTaskId)).toHaveLength(0)
})
test('Given 已持久停止意图但SDK晚到stop When 完成 Then 留原文USD但不能生成，不把abort接受当远端证明', () => {
  const f = accepted(prepared()); expect(runService.requestOwnerPlanningStop(f.executionId)).toBe(true)
  const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, total_cost_usd: 0.3 })!; expect(outcome.state).toBe('stopped'); expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)).toMatchObject({ stopped: true, cost: { source: 'runtime_reported', usd: 0.3 } }); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 已发送或完成的OwnerRun When 普通任务/项目删除 Then 不抹权威执行与收费证据，晚到仍可保存', () => {
  const f = accepted(prepared()); expect(() => store.deleteTask(f.link.planningTaskId)).toThrow('Owner'); expect(() => store.deleteProject(f.project.id)).toThrow('Owner'); expect(store.getAgentExecution(f.executionId)).not.toBeNull()
  const outcome = runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, total_cost_usd: 0.4 })!; expect(outcome.state).toBe('proposed'); expect(() => store.deleteTask(f.link.planningTaskId)).toThrow('Owner'); expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)?.cost.usd).toBe(0.4)
})
test('Given 冻结关联/绑定损坏 When SDK费用终态回调 Then 严格拒绝生成前先隔离保留原始证据，不降级普通回写', () => {
  const f = accepted(prepared()); store.getProjectDb().prepare("UPDATE project_owner_runtime_revisions SET payload = '{}' WHERE project_id = ?").run(f.project.id)
  expect(() => runService.recordOwnerPlanningRun(f.executionId, 'ai-sdk', { ...f.result, total_cost_usd: 0.5 })).toThrow('记录无效'); const row = store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_callback_evidence WHERE execution_id = ?').get(f.executionId) as { payload: string }; expect(JSON.parse(row.payload).runtimeResult.total_cost_usd).toBe(0.5); expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 旧valid回执尚存在但新增stop意图 When 内部生成被误复用 Then 独立守卫拒绝旧回执生成', () => {
  const f = accepted(prepared()), outcome = runService.recordOwnerPlanningRun(f.executionId,'ai-sdk',f.result)!
  store.updateAgentExecution(f.executionId,{status:'running'});runService.requestOwnerPlanningStop(f.executionId)
  expect(() => plans.appendGeneratedOwnerPlan(outcome.receiptId)).toThrow('已经请求停止');expect(plans.getProjectOwnerPlanDraft(f.project.id)?.revision).toBe(1)
})
