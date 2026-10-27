import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildElectronMock } from './testing/electron-mock'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import * as store from './project-sqlite-store'
import { saveProjectOwnerGoalDraft } from './project-owner-goal-service'
import { getOwnerManager, getOwnerManagementView, listPendingOwnerManagementEvents, setOwnerManagerStatus } from './project-owner-management-store'

const directory = mkdtempSync(join(tmpdir(), 'owner-management-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { await store.initProjectDb() })
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
const { saveOwnerRuntimeBinding, prepareOwnerPlanning, getOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const { registerProjectOwnerGoalIpcHandlers } = await import('./project-owner-goal-ipc')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { createAgentEmployee, stopAgentEmployeeHeartbeat } = await import('./agent-employee-service')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { getSettingsPath } = await import('./config-paths')
afterAll(() => { stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function project() { return store.createProject({ title: '持续管理项目', description: '' }) }
function count(table: string): number { return (store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n }
function bind(projectId: string) {
  const workspace = createAgentWorkspace(`管理-${randomUUID()}`)
  bindWorkspaceToProject(projectId, workspace.id)
  const channel = createChannel({ name: '隔离假渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'deepseek-flash', enabled: true }] })
  const carrier = createAgentEmployee({ name: '规划载体', role: '项目规划', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  return saveOwnerRuntimeBinding(projectId, 0, { ownerName: '项目负责人', carrierId: carrier.id, workspaceId: workspace.id, changeReason: '确认本项目规划配置' })
}
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

test('Given 新目标 When 保存与后台处理 Then 产生稳定Owner及同一对话中的主动配置问题，零执行和费用授权', async () => {
  const p = project()
  const before = [count('agent_executions'), count('project_owner_execution_grants'), count('project_owner_planning_admissions')]
  const stop = startOwnerManagementLoop()
  try {
    saveProjectOwnerGoalDraft(p.id, 0, { objective: '给出有证据的产品定位', constraints: ['不要发布'] })
    const manager = getOwnerManager(p.id)!
    expect(manager).toMatchObject({ projectId: p.id, revision: 1, status: 'active' })
    await tick()
    const view = getOwnerManagementView(p.id)
    expect(view.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(view.messages[1]).toMatchObject({ kind: 'configuration_required', conversationId: manager.conversationId })
    expect(view.messages[1]?.content).toContain('模型和团队选择由我负责')
    expect(view.messages[1]?.content).not.toContain('配置可用模型')
    expect(view.messages[1]?.content).not.toContain('核对模型')
    expect(view.pendingEvents).toBe(0)
    saveProjectOwnerGoalDraft(p.id, 1, { objective: '给出有证据的产品定位', constraints: ['不要发布'] })
    await tick()
    expect(getOwnerManager(p.id)).toEqual(manager)
    expect(getOwnerManagementView(p.id).messages).toHaveLength(2)
    expect([count('agent_executions'), count('project_owner_execution_grants'), count('project_owner_planning_admissions')]).toEqual(before)
  } finally { stop() }
})

test('Given 新目标/默认模型和既有项目工作区授权 When Owner后台接手 Then 生成待确认规划且不收费或派发', async () => {
  const p = project()
  const workspace = createAgentWorkspace(`管理-${randomUUID()}`)
  bindWorkspaceToProject(p.id, workspace.id)
  const channel = createChannel({ name: '隔离假渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'deepseek-flash', enabled: true }] })
  writeFileSync(getSettingsPath(), JSON.stringify({ agentChannelId: channel.id, agentModelId: 'deepseek-flash', agentWorkspaceId: workspace.id }))
  const stop = startOwnerManagementLoop()
  try {
    saveProjectOwnerGoalDraft(p.id, 0, { objective: '形成可审阅定位方案' })
    await tick()
    const binding = getOwnerRuntimeBinding(p.id)
    const view = getOwnerManagementView(p.id)
    expect(binding).toMatchObject({ actor: 'system:owner-manager', workspaceId: workspace.id, channelId: channel.id, modelId: 'deepseek-flash' })
    const planningMessage = view.messages.find(item => item.kind === 'planning_confirmation')
    expect(planningMessage).toMatchObject({ role: 'assistant' })
    expect(planningMessage?.content).toContain('目标已保存。持续管理范围尚未确认，我没有发送模型请求')
    expect(planningMessage?.content).toContain('请在下方确认项目总预算和有效期限；确认后我会自动继续')
    expect(planningMessage?.content).not.toContain('发送给模型前会说明本次发送内容与费用')
    expect(view.messages.some(item => item.kind === 'attention')).toBe(false)
    const planningTaskId = planningMessage?.planningTaskId
    expect(store.getTask(planningTaskId!)).toMatchObject({ status: 'paused' })
    expect(store.listAgentExecutionsByEntity('task', planningTaskId!)).toHaveLength(0)
    expect([count('project_owner_execution_grants'), count('project_owner_planning_admissions')]).toEqual([0, 0])
  } finally { stop() }
})

test('Given 外层事务回滚 When 异步唤醒到达 Then 不建立幽灵Owner、消息或规划任务', async () => {
  const p = project(), stop = startOwnerManagementLoop()
  const before = count('project_owner_management_events')
  try {
    expect(() => store.getProjectDb().transaction(() => { saveProjectOwnerGoalDraft(p.id, 0, { objective: '回滚目标' }); throw new Error('rollback') })()).toThrow('rollback')
    await tick()
    expect(getOwnerManagementView(p.id)).toEqual({ manager: null, messages: [], pendingEvents: 0, questions: [], trace: [] })
    expect(count('project_owner_management_events')).toBe(before)
    expect(store.listTasks(p.id)).toHaveLength(0)
  } finally { stop() }
})

test('Given 事件待处理 When 数据库关闭重开并重复启动后台 Then Owner身份不变、问题只出现一次', async () => {
  const p = project()
  saveProjectOwnerGoalDraft(p.id, 0, { objective: '重启后继续管理' })
  const manager = getOwnerManager(p.id)
  store.closeProjectDb(); await store.initProjectDb()
  const stop = startOwnerManagementLoop()
  try {
    expect(getOwnerManager(p.id)).toEqual(manager)
    reconcileOwnerManagement(p.id); reconcileOwnerManagement(p.id)
    expect(getOwnerManagementView(p.id).messages).toHaveLength(2)
    expect(listPendingOwnerManagementEvents(p.id)).toHaveLength(0)
  } finally { stop() }
})

test('Given Owner仅暂停管理循环 When 新目标到达及恢复 Then 暂停期间保留事件、恢复消费一次，旧CAS拒绝', async () => {
  const p = project()
  saveProjectOwnerGoalDraft(p.id, 0, { objective: '初始目标' })
  reconcileOwnerManagement(p.id)
  const paused = setOwnerManagerStatus(p.id, 1, 'paused')
  saveProjectOwnerGoalDraft(p.id, 1, { objective: '修订目标' })
  reconcileOwnerManagement(p.id)
  expect(getOwnerManagementView(p.id).pendingEvents).toBe(1)
  expect(getOwnerManagementView(p.id).messages).toHaveLength(3)
  expect(() => setOwnerManagerStatus(p.id, 1, 'active')).toThrow('已更新')
  const stop = startOwnerManagementLoop()
  try {
    setOwnerManagerStatus(p.id, paused.revision, 'active')
    await tick()
    expect(getOwnerManagementView(p.id).pendingEvents).toBe(0)
    expect(getOwnerManagementView(p.id).messages).toHaveLength(4)
    expect(getOwnerManager(p.id)?.conversationId).toBe(paused.conversationId)
  } finally { stop() }
})

test('Given 目标缺配置 When 用户确认绑定 Then 无页面参与即自动准备一次规划，重复前台准备复用且不收费', async () => {
  const p = project()
  saveProjectOwnerGoalDraft(p.id, 0, { objective: '形成定位方案' })
  reconcileOwnerManagement(p.id)
  const stop = startOwnerManagementLoop()
  try {
    bind(p.id)
    await tick()
    const messages = getOwnerManagementView(p.id).messages
    expect(messages.at(-1)?.kind).toBe('planning_confirmation')
    const taskId = messages.at(-1)?.planningTaskId
    expect(store.listTasks(p.id)).toHaveLength(1)
    expect(store.getTask(taskId!)?.status).toBe('paused')
    expect(store.listAgentExecutionsByEntity('task', taskId!)).toHaveLength(0)
    const context = getProjectOwnerPlanningContext(p.id)
    const link = prepareOwnerPlanning(p.id, { requestId: randomUUID(), expectedBindingRevision: 1, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint })
    expect(link.planningTaskId).toBe(taskId!)
    reconcileOwnerManagement(p.id)
    expect(store.listTasks(p.id)).toHaveLength(1)
    expect(getOwnerManagementView(p.id).messages).toHaveLength(3)
  } finally { stop() }
})

test('Given 快速连续修订目标 When 后台对账 Then 只为最新目标规划且不混入另一项目', () => {
  const p = project(), other = project()
  bind(p.id)
  saveProjectOwnerGoalDraft(p.id, 0, { objective: '旧目标' })
  saveProjectOwnerGoalDraft(p.id, 1, { objective: '新目标' })
  reconcileOwnerManagement(p.id)
  expect(store.listTasks(p.id)).toHaveLength(1)
  expect(getOwnerManagementView(p.id).messages.filter(message => message.role === 'assistant')).toHaveLength(1)
  expect(getOwnerManagementView(other.id)).toEqual({ manager: null, messages: [], pendingEvents: 0, questions: [], trace: [] })
  expect(store.listTasks(other.id)).toHaveLength(0)
})

test('Given 旧项目仅有规划绑定 When 启动后台 Then 不自动启用管理或补造付费许可', () => {
  const p = project()
  bind(p.id)
  const stop = startOwnerManagementLoop()
  try {
    expect(getOwnerManagementView(p.id)).toEqual({ manager: null, messages: [], pendingEvents: 0, questions: [], trace: [] })
    expect(store.listTasks(p.id)).toHaveLength(0)
  } finally { stop() }
})

test('Given 管理状态IPC When 夹带权限/跨主体字段或旧版本 Then 严格拒绝，读取不触发后台', () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  registerProjectOwnerGoalIpcHandlers({ handle: (name, handler) => { handlers.set(name, handler) } })
  const p = project()
  const get = handlers.get(PROJECT_IPC_CHANNELS.GET_OWNER_MANAGEMENT)!
  const set = handlers.get(PROJECT_IPC_CHANNELS.SET_OWNER_MANAGEMENT_STATUS)!
  expect(get({}, { projectId: p.id })).toEqual({ ok: true, value: { manager: null, messages: [], pendingEvents: 0, questions: [], changes: [], trace: [] } })
  expect(get({}, { projectId: p.id, taskId: 'other' })).toMatchObject({ ok: false })
  expect(set({}, { projectId: p.id, expectedRevision: 1, status: 'active', grantId: 'fake' })).toMatchObject({ ok: false })
  expect(set({}, { projectId: p.id, expectedRevision: 1, status: 'active' })).toMatchObject({ ok: false })
  const decide = handlers.get(PROJECT_IPC_CHANNELS.DECIDE_OWNER_CONVERSATION_CHANGE)!
  expect(decide({}, { projectId: p.id, changeId: 'a'.repeat(64), requestId: 'request', action: 'apply', previewHash: 'b'.repeat(64), goal: { objective: '伪造' } })).toMatchObject({ ok: false })
  expect(get({}, { projectId: p.id })).toMatchObject({ ok: true, value: { changes: [] } })
})


test('Given 只有任务目标且配置后补 When 绑定变化 Then 恢复准确任务规划，不要求补造项目目标', async () => {
  const p = project()
  const task = store.createTask(p.id, { title: '任务目标', description: '' })
  saveProjectOwnerGoalDraft(p.id, 0, { objective: '只规划此任务' }, task.id)
  reconcileOwnerManagement(p.id)
  const stop = startOwnerManagementLoop()
  try {
    bind(p.id)
    await tick()
    const last = getOwnerManagementView(p.id).messages.at(-1)
    expect(last?.kind).toBe('planning_confirmation')
    const link = store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_links WHERE planning_task_id = ?').get(last!.planningTaskId!) as { payload: string }
    expect(JSON.parse(link.payload).targetTaskId).toBe(task.id)
    expect(store.listTasks(p.id)).toHaveLength(2)
  } finally { stop() }
})
