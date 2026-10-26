import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
import { getChannelsPath, getSettingsPath } from './config-paths'
const directory = mkdtempSync(join(tmpdir(), 'owner-binding-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel, getChannelById, updateChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext, saveProjectOwnerPlanDraft, confirmProjectOwnerPlanDraft } = await import('./project-owner-plan-service')
const assignmentService = await import('./project-owner-execution-assignment-service')
const service = await import('./project-owner-runtime-binding')
const planningSource = await import('./project-owner-planning-source')
const controlled = await import('./controlled-project-task-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(rootPath?: string) {
  const project = store.createProject({ title: 'Owner定位', description: '' })
  const workspace = createAgentWorkspace(`Owner-${randomUUID()}`, rootPath)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'deepseek-flash', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: '执行载体', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  const binding = { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '明确绑定既有载体' }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '提出可评审的定位建议' })
  return { project, employee, workspace, binding }
}
function request(projectId: string, bindingRevision = 1) { const context = getProjectOwnerPlanningContext(projectId); return { requestId: randomUUID(), expectedBindingRevision: bindingRevision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint } }
function count(table: string) { return (store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c }
test('Given 未绑定Owner When 存目标/准备 Then 目标可存但准备拒绝且零执行', () => { const f = fixture(); expect(service.getOwnerRuntimeBinding(f.project.id)).toBeNull(); expect(() => service.prepareOwnerPlanning(f.project.id, request(f.project.id))).toThrow('绑定'); expect(count('agent_executions')).toBe(0) })
test('Given 应用默认模型和项目已授权工作区 When Owner本地接手 Then 创建专属载体并保留既有员工与零执行', () => {
  const f = fixture()
  writeFileSync(getSettingsPath(), JSON.stringify({ agentChannelId: f.employee.channelId, agentModelId: f.employee.modelId, agentWorkspaceId: f.workspace.id }))
  const priorEmployees = count('agent_employees')
  const binding = service.resolveOwnerRuntimeBindingFromDefaults(f.project.id)
  expect(binding).toMatchObject({ actor: 'system:owner-manager', revision: 1, workspaceId: f.workspace.id, channelId: f.employee.channelId, modelId: f.employee.modelId })
  expect(binding?.carrierId).not.toBe(f.employee.id)
  expect(store.getAgentEmployee(f.employee.id)?.name).toBe('执行载体')
  expect(count('agent_employees')).toBe(priorEmployees + 1)
  expect(count('agent_executions')).toBe(0)
})
test('Given 系统Owner载体配置漂移 When 自动刷新 Then 复用原项目工作区、追加绑定版本且不启动执行', () => {
  const f = fixture()
  writeFileSync(getSettingsPath(), JSON.stringify({ agentChannelId: f.employee.channelId, agentModelId: f.employee.modelId, agentWorkspaceId: f.workspace.id }))
  const first = service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  updateChannel(first.channelId, { name: '已更新的配置名称' })
  const refreshed = service.resolveOwnerRuntimeBindingFromDefaults(f.project.id)
  expect(refreshed).toMatchObject({ actor: 'system:owner-manager', revision: 2, workspaceId: first.workspaceId, ownerName: first.ownerName })
  expect(refreshed?.carrierId).not.toBe(first.carrierId)
  expect(store.getAgentEmployee(first.carrierId)?.name).toBe('执行载体')
  expect(service.getOwnerRuntimeBinding(f.project.id, 1)).toEqual(first)
  expect(count('agent_executions')).toBe(0)
})
test('Given 有兼容模型但项目没有已授权工作区 When Owner本地接手 Then 停止且不创建载体', () => {
  const project = store.createProject({ title: '无授权工作区', description: '' })
  const channel = createChannel({ name: '假渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'deepseek-flash', enabled: true }] })
  writeFileSync(getSettingsPath(), JSON.stringify({ agentChannelId: channel.id, agentModelId: 'deepseek-flash' }))
  const priorEmployees = count('agent_employees')
  expect(service.resolveOwnerRuntimeBindingFromDefaults(project.id)).toBeNull()
  expect(count('agent_employees')).toBe(priorEmployees)
  expect(count('agent_executions')).toBe(0)
})
test('Given 多个兼容模型且没有有效应用默认 When Owner本地接手 Then等待用户明确选择且不创建载体', () => {
  const f = fixture()
  const preferredChannel = createChannel({ name: '最近配置的渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [
    { id: 'preferred-model', name: '首选模型', enabled: true }, { id: 'other-model', name: '另一个模型', enabled: true },
  ] })
  const channelsConfig = JSON.parse(readFileSync(getChannelsPath(), 'utf8')) as { version: number; channels: Array<{ id: string; updatedAt: number; enabled: boolean }> }
  for (const channel of channelsConfig.channels) channel.enabled = channel.id === preferredChannel.id
  channelsConfig.channels.find(channel => channel.id === preferredChannel.id)!.updatedAt = Date.now() + 60_000
  writeFileSync(getChannelsPath(), JSON.stringify(channelsConfig))
  writeFileSync(getSettingsPath(), JSON.stringify({ agentWorkspaceId: f.workspace.id }))
  const before = count('agent_employees')
  const result = service.resolveOwnerRuntimeBindingFromDefaults(f.project.id)
  expect(result).toBeNull()
  expect(count('agent_employees')).toBe(before)
  expect(count('agent_executions')).toBe(0)
})
test('Given 默认模型没有审核价格且另有有界价格证据模型 When首次系统绑定 Then自动选择合格模型且不发送请求', () => {
  const f = fixture()
  const unreviewed = createChannel({ name: '应用默认未审核渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'owner-ui-unreviewed-model', name: '未审核模型', enabled: true }] })
  const reviewed = createChannel({ name: '审核模型候选', provider: 'zhipu', baseUrl: 'http://127.0.0.1:9/api/paas/v4', apiKey: 'local-placeholder', enabled: true, models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', enabled: true }] })
  const channelsConfig = JSON.parse(readFileSync(getChannelsPath(), 'utf8')) as { version: number; channels: Array<{ id: string; updatedAt: number }> }
  channelsConfig.channels.find(channel => channel.id === unreviewed.id)!.updatedAt = Date.now() + 1
  channelsConfig.channels.find(channel => channel.id === reviewed.id)!.updatedAt = Date.now() + 2
  writeFileSync(getChannelsPath(), JSON.stringify(channelsConfig))
  writeFileSync(getSettingsPath(), JSON.stringify({ agentChannelId: unreviewed.id, agentModelId: 'owner-ui-unreviewed-model', agentWorkspaceId: f.workspace.id }))
  const before = count('agent_executions')
  const binding = service.resolveOwnerRuntimeBindingFromDefaults(f.project.id)
  expect(binding).toMatchObject({ actor: 'system:owner-manager', channelId: reviewed.id, modelId: 'glm-5.3-flash', workspaceId: f.workspace.id })
  expect(count('agent_executions')).toBe(before)
})
test('Given GLM-5.3-Flash已配置但应用默认是其他兼容模型 When首次系统绑定 Then Owner默认优先绑定GLM且不发送请求', () => {
  const f = fixture()
  createChannel({ name: '智谱 GLM', provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', enabled: true }] })
  writeFileSync(getSettingsPath(), JSON.stringify({ agentChannelId: f.employee.channelId, agentModelId: f.employee.modelId, agentWorkspaceId: f.workspace.id }))
  const before = count('agent_executions')
  const binding = service.resolveOwnerRuntimeBindingFromDefaults(f.project.id)
  expect(binding).toMatchObject({ actor: 'system:owner-manager', modelId: 'glm-5.3-flash', workspaceId: f.workspace.id })
  expect(getChannelById(binding!.channelId)?.provider).toBe('zhipu')
  expect(count('agent_executions')).toBe(before)
})
test('Given 配置 When CAS保存 Then 严格版本且不更名/升级载体，不给权限', () => { const f = fixture(); const first = service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); expect(first).toMatchObject({ revision: 1, ownerRole: 'project_owner', carrierId: f.employee.id, runtime: 'ai-sdk', modelId: 'deepseek-flash' }); expect(() => service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)).toThrow('更新'); expect(store.getAgentEmployee(f.employee.id)?.name).toBe('执行载体'); expect(count('agent_executions')).toBe(0) })
test('Given 新版绑定 When载体仅增加运行统计 Then稳定配置指纹不误报漂移', () => { const f = fixture(); const binding = service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); store.getProjectDb().prepare('UPDATE agent_employees SET total_tasks = total_tasks + 1, updated_at = updated_at + 1 WHERE id = ?').run(f.employee.id); const facts = service.getOwnerCarrierFacts(f.project.id, f.employee.id, f.workspace.id); expect(service.ownerCarrierBindingMatches(binding, facts)).toBe(true) })
test('Given 已生成Owner规划来源 When载体仅增加运行统计 Then发送来源解析仍当前', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const prepared = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); store.getProjectDb().prepare('UPDATE agent_employees SET total_tasks = total_tasks + 1, updated_at = updated_at + 1 WHERE id = ?').run(f.employee.id); expect(planningSource.resolveOwnerPlanningTask(prepared.planningTaskId)?.link.id).toBe(prepared.id) })
test('Given 合法绑定 When 准备/重复 Then 首次paused仅一个权威承载任务，业务任务不改，无执行', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const r = request(f.project.id); const first = service.prepareOwnerPlanning(f.project.id, r); expect(store.getTask(first.planningTaskId)).toMatchObject({ status: 'paused', assignee: { userId: `agent-${f.employee.id}` } }); expect(first.targetTaskId).toBeUndefined(); expect(service.prepareOwnerPlanning(f.project.id, r)).toEqual(first); expect(count('agent_executions')).toBe(0); const preview = controlled.getControlledTaskStartPreview(first.planningTaskId); expect(preview.ownerPlanning?.linkId).toBe(first.id); expect(preview.ownerPlanning?.managementSupported).toBe(true); expect(() => service.prepareOwnerPlanning(f.project.id, { ...r, expectedGoalRevision: 99 })).toThrow() })
test('Given 旧Goal/来源/配置或注入 When 准备 Then 拒绝且不产生承载任务', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const r = request(f.project.id); const before = count('tasks'); for (const patch of [{ expectedGoalRevision: 2 }, { expectedBindingRevision: 2 }, { expectedPlanRevision: 1 }, { expectedContextFingerprint: '0'.repeat(64) }, { actor: 'admin' }, { purpose: 'general' }]) expect(() => service.prepareOwnerPlanning(f.project.id, { ...r, ...patch })).toThrow(); expect(count('tasks')).toBe(before) })
test('Given 单任务目标 When 准备 Then target与carrier任务分开，业务任务内容不改', () => { const f = fixture(); const task = store.createTask(f.project.id, { title: '业务任务', description: '业务成果' }); saveProjectOwnerGoalDraft(f.project.id, 0, { objective: '规划业务成果' }, task.id); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const context = getProjectOwnerPlanningContext(f.project.id, task.id); const before = store.getTask(task.id); const result = service.prepareOwnerPlanning(f.project.id, { ...request(f.project.id), taskId: task.id, expectedContextFingerprint: context.fingerprint }); expect(result.targetTaskId).toBe(task.id); expect(result.planningTaskId).not.toBe(task.id); expect(store.getTask(task.id)).toEqual(before) })
test('Given 任务目标已明确同意读取绑定工作区 When 规划上下文加载 Then 只返回有界源码证据且绑定于工作区/目标指纹', () => {
  const root = join(directory, `repo-${randomUUID()}`); mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'quote.ts'), 'export function quote(quantity: number) {\n  if (quantity < 0) throw new Error("negative")\n  return quantity * 12\n}\n')
  const f = fixture(root), task = store.createTask(f.project.id, { title: '修复负数量报价', description: '处理数量小于零时的报价错误' })
  service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  saveProjectOwnerGoalDraft(f.project.id, 0, { objective: '修复负数量报价并保留正常行为', codeSourceAccess: 'bound_workspace' }, task.id)
  const context = getProjectOwnerPlanningContext(f.project.id, task.id)
  expect(context.sources.code).toMatchObject({ workspaceId: f.workspace.id, filesScanned: 1, truncated: false })
  expect(context.sources.code?.files[0]).toMatchObject({ path: 'src/quote.ts', excerpts: [{ line: 1 }] })
  expect(() => getProjectOwnerPlanningContext(f.project.id)).not.toThrow()
  const link = service.prepareOwnerPlanning(f.project.id, { requestId: randomUUID(), taskId: task.id, expectedBindingRevision: 1,
    expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint })
  writeFileSync(join(root, 'src', 'quote.ts'), 'export function quote(quantity: number) { return Math.max(0, quantity) * 12 }\n')
  expect(planningSource.readOwnerPlanningSnapshot(link.planningTaskId)?.context.sources.code?.files[0]?.sha256).toBe(context.sources.code?.files[0]?.sha256)
  expect(() => planningSource.resolveOwnerPlanningTask(link.planningTaskId)).toThrow('已更新')
})
test('Given owner关联缺失 When 普通启动预检 Then preparation目的标记仍fail closed', () => { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const result = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); store.getProjectDb().prepare('DELETE FROM project_owner_planning_links WHERE id = ?').run(result.id); expect(() => controlled.getControlledTaskStartPreview(result.planningTaskId)).toThrow('目的证据缺失') })
test('Given 已确认计划与可用团队 When Owner准备安排提案 Then 冻结候选资料且只创建暂停请求，不派工', () => {
  const f = fixture()
  service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  const context = getProjectOwnerPlanningContext(f.project.id)
  const roleKey = context.sources.roles[0]?.key
  expect(roleKey).toBeTruthy()
  const executor = employees.createAgentEmployee({ name: '研究员工', role: '研究', roleTemplateId: roleKey!, description: '用户研究与资料整理', skills: ['研究分析'], executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: (store.getAgentEmployee(f.employee.id)!).channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
  const reviewer = employees.createAgentEmployee({ name: '独立评审', role: '交付核验', roleTemplateId: 'reviewer', description: '独立核验', skills: ['验收'], executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: (store.getAgentEmployee(f.employee.id)!).channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
  const draft = saveProjectOwnerPlanDraft(f.project.id, context.goal.revision, 0, { expectedContextFingerprint: context.fingerprint, summary: '完成研究提案', assumptions: [], risks: [], steps: [{ key: 'research-step', title: '研究', outcome: '研究报告', acceptanceCriteria: ['包含来源'], roleKey, dependencies: [] }], changeReason: '初始计划' })
  const confirmed = confirmProjectOwnerPlanDraft(f.project.id, context.goal.revision, draft.revision)
  const current = getProjectOwnerPlanningContext(f.project.id)
  const input = { requestId: randomUUID(), expectedBindingRevision: 1, expectedGoalRevision: current.goal.revision, expectedPlanRevision: confirmed.revision, expectedPlanFingerprint: confirmed.planFingerprint, expectedContextFingerprint: current.fingerprint }
  const beforeExecutions = count('agent_executions')
  const link = assignmentService.prepareOwnerExecutionAssignment({ projectId: f.project.id }, input)
  expect(link).toMatchObject({ purpose: 'owner_execution_assignment', assignmentProtocolVersion: '2', maxOutputTokens: 8192 })
  expect(link.assignmentContextFingerprint).toMatch(/^[a-f0-9]{64}$/)
  const task = store.getTask(link.planningTaskId)
  expect(task).toMatchObject({ status: 'paused', assignee: { userId: `agent-${f.employee.id}` }, workspaceId: f.workspace.id })
  const frozen = planningSource.readOwnerPlanningSnapshot(link.planningTaskId)
  expect(frozen?.assignmentContext?.candidates.map(candidate => candidate.id)).toContain(executor.id)
  expect(frozen?.assignmentContext?.candidates.map(candidate => candidate.id)).toContain(reviewer.id)
  expect(assignmentService.prepareOwnerExecutionAssignment({ projectId: f.project.id }, input)).toEqual(link)
  expect(count('agent_executions')).toBe(beforeExecutions)
  const preview = controlled.getControlledTaskStartPreview(link.planningTaskId)
  expect(preview.ownerPlanning).toMatchObject({ purpose: 'owner_execution_assignment', assignmentProtocolVersion: '2', maxOutputTokens: 8192, costs: 'unknown_no_hard_cap', assignmentContext: { contextFingerprint: link.assignmentContextFingerprint } })
  const run = store.createAgentExecution({ id: randomUUID(), projectId: f.project.id, entityType: 'task', entityId: link.planningTaskId, agentId: f.employee.id, sessionId: randomUUID(), status: 'queued', prompt: '安排请求' })
  expect(assignmentService.prepareOwnerExecutionAssignment({ projectId: f.project.id }, input)).toEqual(link)
  expect(() => assignmentService.prepareOwnerExecutionAssignment({ projectId: f.project.id }, { ...input, requestId: randomUUID() })).toThrow('正在运行')
  expect(count('agent_executions')).toBe(beforeExecutions + 1)
  store.updateAgentExecution(run.id, { status: 'completed', completedAt: Date.now() })
  store.getProjectDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run('completed', link.planningTaskId)
  expect(assignmentService.listOwnerExecutionAssignmentRuns({ projectId: f.project.id })[0]?.sourceStatus).toBe('current')
})
test('Given Owner安排来源已准备 When 候选资料变化 Then 不复用旧安排Run', () => {
  const f = fixture()
  service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  const context = getProjectOwnerPlanningContext(f.project.id)
  const roleKey = context.sources.roles[0]?.key
  expect(roleKey).toBeTruthy()
  employees.createAgentEmployee({ name: '研究员工', role: '研究', roleTemplateId: roleKey!, description: '研究', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: store.getAgentEmployee(f.employee.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
  employees.createAgentEmployee({ name: '独立评审', role: '评审', roleTemplateId: 'reviewer', description: '核验', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: store.getAgentEmployee(f.employee.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
  const draft = saveProjectOwnerPlanDraft(f.project.id, context.goal.revision, 0, { expectedContextFingerprint: context.fingerprint, summary: '计划', assumptions: [], risks: [], steps: [{ key: 's1', title: '研究', outcome: '报告', acceptanceCriteria: ['证据'], roleKey, dependencies: [] }], changeReason: '计划' })
  const plan = confirmProjectOwnerPlanDraft(f.project.id, context.goal.revision, draft.revision)
  const current = getProjectOwnerPlanningContext(f.project.id)
  const input = { requestId: randomUUID(), expectedBindingRevision: 1, expectedGoalRevision: current.goal.revision, expectedPlanRevision: plan.revision, expectedPlanFingerprint: plan.planFingerprint, expectedContextFingerprint: current.fingerprint }
  const link = assignmentService.prepareOwnerExecutionAssignment({ projectId: f.project.id }, input)
  const candidate = store.listAgentEmployees().find(employee => employee.name === '研究员工')!
  employees.updateAgentEmployee(candidate.id, { description: '新的技能与工作说明' })
  expect(() => planningSource.resolveOwnerPlanningTask(link.planningTaskId)).toThrow('团队候选已变化')
  expect(assignmentService.listOwnerExecutionAssignmentRuns({ projectId: f.project.id })[0]).toMatchObject({ sourceStatus: 'stale', sourceDetail: expect.stringContaining('团队候选已变化') })
  expect(() => assignmentService.prepareOwnerExecutionAssignment({ projectId: f.project.id }, input)).toThrow('同一Owner安排请求ID')
})
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
  expect(() => controlled.getControlledTaskStartPreview(result.planningTaskId)).toThrow('目的证据缺失')
})
test('Given 已有关联的规划承载任务 When 再作为业务目标准备 Then 不允许递归承载', () => {
  const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const first = service.prepareOwnerPlanning(f.project.id, request(f.project.id))
  saveProjectOwnerGoalDraft(f.project.id, 0, { objective: '不应嵌套' }, first.planningTaskId)
  const context = getProjectOwnerPlanningContext(f.project.id, first.planningTaskId)
  expect(() => service.prepareOwnerPlanning(f.project.id, { ...request(f.project.id), taskId: first.planningTaskId, expectedContextFingerprint: context.fingerprint })).toThrow('承载任务')
})


test('Given 已明确绑定其他模型且随后新增GLM When 渠道配置刷新 Then 保留原模型身份及历史绑定', () => {
  const f = fixture()
  const first = service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  createChannel({ name: '新增GLM默认', provider: 'zhipu', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: 'GLM', enabled: true }] })
  updateChannel(first.channelId, { name: '更新渠道名称' })
  const result = service.resolveOwnerRuntimeBindingFromDefaults(f.project.id)
  expect(result).toMatchObject({ revision: 2, channelId: first.channelId, modelId: first.modelId })
  expect(service.getOwnerRuntimeBinding(f.project.id, 1)).toEqual(first)
})
