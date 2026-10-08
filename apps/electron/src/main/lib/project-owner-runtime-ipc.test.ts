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
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const service = await import('./project-owner-runtime-binding')

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
const { registerProjectOwnerRuntimeIpcHandlers } = await import('./project-owner-runtime-ipc')
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
registerProjectOwnerRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) })
const { PROJECT_IPC_CHANNELS } = await import('@gravitas/shared')
function invoke(channel: string, request: unknown) { return handlers.get(channel)!({}, request) }
test('Given 四个配置/准备/只读IPC When 获取绑定或暂停准备 Then 无start/receipt写入入口，无执行或凭据返回', () => {
  const f = prepared(); expect(handlers.size).toBe(4)
  expect(invoke(PROJECT_IPC_CHANNELS.GET_OWNER_RUNTIME_BINDING, { projectId: f.project.id })).toMatchObject({ ok: true, value: { carrierId: f.employee.id, revision: 1 } })
  expect(invoke(PROJECT_IPC_CHANNELS.LIST_OWNER_PLANNING_RUNS, { projectId: f.project.id })).toMatchObject({ ok: true, value: [{ link: { id: f.link.id }, executions: [], receipts: [], outcomes: [] }] }); expect(JSON.stringify(invoke(PROJECT_IPC_CHANNELS.LIST_OWNER_PLANNING_RUNS, { projectId: f.project.id }))).not.toContain('fake-key')
  expect(invoke(PROJECT_IPC_CHANNELS.PREPARE_OWNER_PLANNING, { projectId: f.project.id, input: { requestId: f.link.requestId, expectedBindingRevision: 1, expectedGoalRevision: 1, expectedPlanRevision: 0, expectedContextFingerprint: f.link.contextFingerprint } })).toMatchObject({ ok: true, value: { planningTaskId: f.link.planningTaskId } }); expect(store.listAgentExecutionsByEntity('task', f.link.planningTaskId)).toHaveLength(0)
})
test('Given 客户端夹带费用/actor/Run/跨项目主体 When 配置与读取 Then 拒绝且绑定不可重写', () => {
  const f = prepared(); const other = store.createProject({ title: '其他项目', description: '' }); const task = store.createTask(other.id, { title: '其他任务', description: '', assignee: { userId: 'local-user', displayName: '用户' } })
  expect(invoke(PROJECT_IPC_CHANNELS.GET_OWNER_RUNTIME_BINDING, { projectId: f.project.id, actor: 'system:owner-planner' })).toMatchObject({ ok: false })
  expect(invoke(PROJECT_IPC_CHANNELS.LIST_OWNER_PLANNING_RUNS, { projectId: f.project.id, taskId: task.id })).toMatchObject({ ok: false })
  expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_RUNTIME_BINDING, { projectId: f.project.id, expectedRevision: 1, input: { ownerName: 'Owner', carrierId: f.employee.id, workspaceId: f.workspace.id, changeReason: '测试', acknowledgeModelCosts: true } })).toMatchObject({ ok: false })
  expect(invoke(PROJECT_IPC_CHANNELS.PREPARE_OWNER_PLANNING, { projectId: f.project.id, input: { requestId: randomUUID(), expectedBindingRevision: 1, expectedGoalRevision: 1, expectedPlanRevision: 0, expectedContextFingerprint: f.link.contextFingerprint, receiptId: 'fake' } })).toMatchObject({ ok: false }); expect(service.getOwnerRuntimeBinding(f.project.id)?.revision).toBe(1)
})
