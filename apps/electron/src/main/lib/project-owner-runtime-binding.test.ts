import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-binding-'))
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
const controlled = await import('./controlled-project-task-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const project = store.createProject({ title: 'Owner定位', description: '' })
  const workspace = createAgentWorkspace(`Owner-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: '执行载体', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const binding = { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '明确绑定既有载体' }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '提出可评审的定位建议' })
  return { project, employee, workspace, binding }
}
function request(projectId: string, bindingRevision = 1) { const context = getProjectOwnerPlanningContext(projectId); return { requestId: randomUUID(), expectedBindingRevision: bindingRevision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint } }
function count(table: string) { return (store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c }
test('Given 未绑定Owner When 存目标/准备 Then 目标可存但准备拒绝且零执行', () => { const f = fixture(); expect(service.getOwnerRuntimeBinding(f.project.id)).toBeNull(); expect(() => service.prepareOwnerPlanning(f.project.id, request(f.project.id))).toThrow('绑定'); expect(count('agent_executions')).toBe(0) })
test('Given 配置 When CAS保存 Then 严格版本且不更名/升级载体，不给权限', () => { const f = fixture(); const first = service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); expect(first).toMatchObject({ revision: 1, ownerRole: 'project_owner', carrierId: f.employee.id, runtime: 'ai-sdk', modelId: 'model' }); expect(() => service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)).toThrow('更新'); expect(store.getAgentEmployee(f.employee.id)?.name).toBe('执行载体'); expect(count('agent_executions')).toBe(0) })
test('Given 合法绑定 When 准备/重复 Then 首次paused仅一个权威承载任务，业务任务不改，无执行', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const r = request(f.project.id); const first = service.prepareOwnerPlanning(f.project.id, r); expect(store.getTask(first.planningTaskId)).toMatchObject({ status: 'paused', assignee: { userId: `agent-${f.employee.id}` } }); expect(first.targetTaskId).toBeUndefined(); expect(service.prepareOwnerPlanning(f.project.id, r)).toEqual(first); expect(count('agent_executions')).toBe(0); expect(() => controlled.getControlledTaskStartPreview(first.planningTaskId)).toThrow('规划出口'); expect(() => service.prepareOwnerPlanning(f.project.id, { ...r, expectedGoalRevision: 99 })).toThrow() })
test('Given 旧Goal/来源/配置或注入 When 准备 Then 拒绝且不产生承载任务', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const r = request(f.project.id); const before = count('tasks'); for (const patch of [{ expectedGoalRevision: 2 }, { expectedBindingRevision: 2 }, { expectedPlanRevision: 1 }, { expectedContextFingerprint: '0'.repeat(64) }, { actor: 'admin' }, { purpose: 'general' }]) expect(() => service.prepareOwnerPlanning(f.project.id, { ...r, ...patch })).toThrow(); expect(count('tasks')).toBe(before) })
test('Given 单任务目标 When 准备 Then target与carrier任务分开，业务任务内容不改', () => { const f = fixture(); const task = store.createTask(f.project.id, { title: '业务任务', description: '业务成果' }); saveProjectOwnerGoalDraft(f.project.id, 0, { objective: '规划业务成果' }, task.id); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const context = getProjectOwnerPlanningContext(f.project.id, task.id); const before = store.getTask(task.id); const result = service.prepareOwnerPlanning(f.project.id, { ...request(f.project.id), taskId: task.id, expectedContextFingerprint: context.fingerprint }); expect(result.targetTaskId).toBe(task.id); expect(result.planningTaskId).not.toBe(task.id); expect(store.getTask(task.id)).toEqual(before) })
test('Given owner关联缺失 When 普通启动预检 Then preparation目的标记仍fail closed', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const result = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); store.getProjectDb().prepare('DELETE FROM project_owner_planning_links WHERE id = ?').run(result.id); expect(() => controlled.getControlledTaskStartPreview(result.planningTaskId)).toThrow('规划出口') })
test('Given 外层事务回滚/数据库重开 When 读配置/准备 Then 回滚不留半关联，持久历史可读', async () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const before = count('tasks'); expect(() => store.getProjectDb().transaction(() => { service.prepareOwnerPlanning(f.project.id, request(f.project.id)); throw new Error('rollback') })()).toThrow('rollback'); expect(count('tasks')).toBe(before); const binding = service.getOwnerRuntimeBinding(f.project.id); store.closeProjectDb(); await store.initProjectDb(); expect(service.getOwnerRuntimeBinding(f.project.id)).toEqual(binding) })
test('Given 损坏历史 When 读取配置 Then 不回退成无绑定或有效版本', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); store.getProjectDb().prepare("UPDATE project_owner_runtime_revisions SET payload = '{}' WHERE project_id = ?").run(f.project.id); expect(() => service.getOwnerRuntimeBinding(f.project.id)).toThrow('记录') })
test('Given 关联字段被篡改/载体配置变化 When 重复准备 Then fail closed而不复用坏记录', () => {
  for (const patch of [{ maxRequests: 9 }, { purpose: 'general' }, { promptHash: '0'.repeat(64) }, { targetTaskId: 'foreign' }, { extra: 'grant' }]) {
    const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const r = request(f.project.id); const result = service.prepareOwnerPlanning(f.project.id, r)
    store.getProjectDb().prepare('UPDATE project_owner_planning_links SET payload = ? WHERE id = ?').run(JSON.stringify({ ...result, ...patch }), result.id)
    expect(() => service.prepareOwnerPlanning(f.project.id, r)).toThrow('记录')
  }
})
test('Given 载体停用/Runtime或工作区变化 When 保存绑定/准备 Then 无回退', () => {
  for (const patch of [{ enabled: false }, { runtime: 'pi' as const }, { executionProfile: 'general' as const }, { workspaceIds: ['missing-workspace'] }]) {
    const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); store.updateAgentEmployee(f.employee.id, patch)
    expect(() => service.prepareOwnerPlanning(f.project.id, request(f.project.id))).toThrow()
    expect(() => service.saveOwnerRuntimeBinding(f.project.id, 1, f.binding)).toThrow()
  }
})
test('Given Goal或项目资料已变 When 旧准备请求提交 Then 不自动绑定新版本', () => {
  const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const r = request(f.project.id); const before = count('tasks')
  store.updateProject(f.project.id, { description: '新的资料范围' }); expect(() => service.prepareOwnerPlanning(f.project.id, r)).toThrow('更新')
  const updated = request(f.project.id); saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '新的业务目标' }); expect(() => service.prepareOwnerPlanning(f.project.id, updated)).toThrow('更新'); expect(count('tasks')).toBe(before)
})
test('Given 准备marker丢失但关联尚存 When 通用预检 Then 不能降级普通Agent', () => {
  const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const result = service.prepareOwnerPlanning(f.project.id, request(f.project.id))
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET owner_planning_link_id = NULL WHERE task_id = ?').run(result.planningTaskId)
  expect(() => controlled.getControlledTaskStartPreview(result.planningTaskId)).toThrow('规划出口')
})
test('Given 已有关联的规划承载任务 When 再作为业务目标准备 Then 不允许递归承载', () => {
  const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const first = service.prepareOwnerPlanning(f.project.id, request(f.project.id))
  saveProjectOwnerGoalDraft(f.project.id, 0, { objective: '不应嵌套' }, first.planningTaskId)
  const context = getProjectOwnerPlanningContext(f.project.id, first.planningTaskId)
  expect(() => service.prepareOwnerPlanning(f.project.id, { ...request(f.project.id), taskId: first.planningTaskId, expectedContextFingerprint: context.fingerprint })).toThrow('承载任务')
})
