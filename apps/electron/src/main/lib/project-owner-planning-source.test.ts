import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderType } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-source-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const service = await import('./project-owner-runtime-binding')
const source = await import('./project-owner-planning-source')
const controlledTask = await import('./controlled-project-task-service')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(provider: ProviderType = 'openai', modelId = 'model') {
  const project = store.createProject({ title: 'Owner定位', description: '' })
  const workspace = createAgentWorkspace(`Owner-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假渠道', provider, baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = employees.createAgentEmployee({ name: '执行载体', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const binding = { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '明确绑定既有载体' }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '提出可评审的定位建议' })
  return { project, employee, workspace, binding }
}
function request(projectId: string, bindingRevision = 1) { const context = getProjectOwnerPlanningContext(projectId); return { requestId: randomUUID(), expectedBindingRevision: bindingRevision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint } }
function prepared() { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const link = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); return { ...f, link } }
function running(f: ReturnType<typeof prepared>) {
  const sessionId = randomUUID(), executionId = randomUUID()
  store.createAgentExecution({ id: executionId, projectId: f.project.id, entityType: 'task', entityId: f.link.planningTaskId, agentId: f.employee.id, sessionId, status: 'running', prompt: '不能信任此角色原文' })
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, f.link.planningTaskId)
  return { executionId, sessionId }
}
test('Given 无Owner证据的普通会话 When 解析 Then 不伪造规划用途', () => { expect(source.resolveOwnerPlanningSession('missing')).toBeNull() })
test('Given DeepSeek Flash OpenAI兼容绑定 When新建准备 Then冻结v4 JSON输出且幂等回读', () => {
  const f = fixture('openai', 'deepseek-flash')
  service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  const input = request(f.project.id), link = service.prepareOwnerPlanning(f.project.id, input)
  expect(link).toMatchObject({ protocolVersion: '4', maxRequests: 1, maxOutputTokens: 8192 })
  expect(source.resolveOwnerPlanningTask(link.planningTaskId)?.link).toEqual(link)
  expect(service.prepareOwnerPlanning(f.project.id, input)).toEqual(link)
})
test('Given 智谱GLM-5.3-FLASH绑定 When 准备Owner规划 Then 冻结v3和low推理强度', () => {
  const f = fixture('zhipu', 'glm-5.3-flash')
  service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  const link = service.prepareOwnerPlanning(f.project.id, request(f.project.id))
  expect(link).toMatchObject({ protocolVersion: '5', reasoningEffort: 'low', maxOutputTokens: 8192 })
  expect(source.readOwnerPlanningSnapshot(link.planningTaskId)?.link).toEqual(link)
  expect(source.resolveOwnerPlanningTask(link.planningTaskId)?.binding.modelId).toBe('glm-5.3-flash')
})
test('Given 权威Owner关联 When 解析任务/当前执行 Then 原文只含冻结protocol数据且无新调用', () => {
  const f = prepared(); const run = running(f); const scope = source.resolveOwnerPlanningSession(run.sessionId)!
  expect(scope.executionId).toBe(run.executionId); expect(scope.link.id).toBe(f.link.id); expect(scope.request.userPrompt).not.toContain('不能信任此角色原文'); expect(JSON.parse(scope.request.userPrompt).goal.objective).toContain('定位建议')
  expect(scope.request.systemPrompt).toContain('不执行任何任务')
})
test('Given 历史v1规划关联 When 读取冻结资料 Then 保留旧4096输出协议', () => {
  const f = prepared()
  const row = store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_links WHERE id = ?').get(f.link.id) as { payload: string }
  const payload = JSON.parse(row.payload) as Record<string, unknown>
  payload.protocolVersion = '1'
  payload.maxOutputTokens = 4096
  store.getProjectDb().prepare('UPDATE project_owner_planning_links SET payload = ? WHERE id = ?').run(JSON.stringify(payload), f.link.id)
  expect(source.readOwnerPlanningSnapshot(f.link.planningTaskId)?.link).toMatchObject({ protocolVersion: '1', maxOutputTokens: 4096 })
  expect(service.prepareOwnerPlanning(f.project.id, { ...request(f.project.id), requestId: f.link.requestId })).toMatchObject({ protocolVersion: '1', maxOutputTokens: 4096 })
})
test('Given 关联/目的任一证据丢失或篡改 When 解析 Then 拒绝而非null', () => {
  for (const sql of ['DELETE FROM project_owner_planning_links WHERE planning_task_id = ?', 'UPDATE controlled_task_preparations SET owner_planning_link_id = NULL WHERE task_id = ?', "UPDATE project_owner_planning_links SET source_snapshot = '{}' WHERE planning_task_id = ?", "UPDATE project_owner_planning_links SET input_hash = 'bad' WHERE planning_task_id = ?"]) { const f = prepared(); store.getProjectDb().prepare(sql).run(f.link.planningTaskId); expect(() => source.resolveOwnerPlanningTask(f.link.planningTaskId)).toThrow() }
})
test('Given 当前Goal/Plan来源变化 When 发送解析 Then 拒绝；冻结资料仍供晚到回执核查', () => {
  const f = prepared(); const run = running(f); saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '后来目标' }); expect(() => source.resolveOwnerPlanningSession(run.sessionId)).toThrow('更新'); expect(source.readOwnerPlanningSnapshot(f.link.planningTaskId)?.context.goal.goal.objective).toContain('定位建议')
})
test('Given Owner规划已有Run执行 When 用户再次预检规划占位任务 Then 提示回到项目主页审阅计划且零新增执行或请求', () => {
  const f = prepared()
  running(f)
  const executionsBefore = (store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number }).c
  expect(() => controlledTask.getControlledTaskStartPreview(f.link.planningTaskId)).toThrow('这次Owner规划已完成或已有发送记录')
  expect(() => controlledTask.getControlledTaskStartPreview(f.link.planningTaskId)).toThrow('这次Owner规划已完成或已有发送记录')
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number }).c).toBe(executionsBefore)
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_planning_admissions').get() as { c: number }).c).toBe(0)
})
test('Given Owner规划仅有发送准入尚无执行登记 When 用户预检规划占位任务 Then 同样拒绝且不补造执行', () => {
  const f = prepared()
  const admissionsBefore = (store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_planning_admissions').get() as { c: number }).c
  store.getProjectDb().prepare('INSERT INTO project_owner_planning_admissions (link_id, execution_id, session_id, request_hash, source_snapshot, admitted_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(f.link.id, randomUUID(), randomUUID(), 'hash', '{}', Date.now())
  const executionsBefore = (store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number }).c
  expect(() => controlledTask.getControlledTaskStartPreview(f.link.planningTaskId)).toThrow('这次Owner规划已完成或已有发送记录')
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM agent_executions').get() as { c: number }).c).toBe(executionsBefore)
  store.getProjectDb().prepare('DELETE FROM project_owner_planning_admissions WHERE link_id = ?').run(f.link.id)
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_planning_admissions').get() as { c: number }).c).toBe(admissionsBefore)
})
test('Given 旧A无资料快照 When 明确重复准备且来源仍当前 Then 补快照但不补执行', () => {
  const f = prepared(); store.getProjectDb().prepare('UPDATE project_owner_planning_links SET source_snapshot = NULL WHERE id = ?').run(f.link.id)
  expect(() => source.resolveOwnerPlanningTask(f.link.planningTaskId)).toThrow('记录'); expect(service.prepareOwnerPlanning(f.project.id, { ...request(f.project.id), requestId: f.link.requestId }).id).toBe(f.link.id); expect(source.resolveOwnerPlanningTask(f.link.planningTaskId)).not.toBeNull()
})
test('Given 伪造running却无本次费用确认 When 最终占位 Then 本次费用确认门禁拒绝且无准入', () => {
  const f = prepared(); const run = running(f); const scope = source.resolveOwnerPlanningSession(run.sessionId)!
  const body = JSON.stringify({ model: f.employee.modelId, max_tokens: 8192, stream: true, messages: [{ role: 'system', content: scope.request.systemPrompt }, { role: 'user', content: scope.request.userPrompt }] })
  expect(() => claimOwnerPlanningProviderRequest(run.sessionId, body, new URL('https://example.invalid/v1/chat/completions'))).toThrow('启动确认缺失')
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_planning_admissions').get() as { c: number }).c).toBe(0)
})
