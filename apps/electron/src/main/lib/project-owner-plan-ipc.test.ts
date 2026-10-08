import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalResult, type ProjectOwnerPlanDraft } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-plan-ipc-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const goals = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const { registerProjectOwnerPlanIpcHandlers } = await import('./project-owner-plan-ipc')
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
beforeAll(async () => {
  await store.initProjectDb()
  registerProjectOwnerPlanIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } })
})
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
function invoke(channel: string, request: unknown): ProjectOwnerGoalResult<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('Owner计划IPC未注册')
  return handler({}, request) as ProjectOwnerGoalResult<unknown>
}
function fixture() {
  const p = store.createProject({ title: '计划IPC夹具', description: '' })
  goals.saveProjectOwnerGoalDraft(p.id, 0, { objective: '形成可审阅方案' })
  const context = plans.getProjectOwnerPlanningContext(p.id)
  const request = { projectId: p.id, expectedGoalRevision: 1, expectedRevision: 0, input: {
    expectedContextFingerprint: context.fingerprint, summary: '明确需求', assumptions: [], risks: [], changeReason: '首次提案',
    steps: [{ key: 'brief', title: '梳理需求', outcome: '需求简报', acceptanceCriteria: ['标准明确'], dependencies: [], roleKey: 'requirements-analyst' }],
  } }
  return { p, request }
}

test('五个IPC注册，严格返回来源、空读/历史和proposed→confirmed，固定人工actor', () => {
  const { p, request } = fixture()
  expect(handlers.size).toBe(5)
  expect(invoke(PROJECT_IPC_CHANNELS.GET_OWNER_PLANNING_CONTEXT, { projectId: p.id })).toMatchObject({ ok: true, value: { goal: { revision: 1 } } })
  expect(invoke(PROJECT_IPC_CHANNELS.GET_OWNER_PLAN_DRAFT, { projectId: p.id })).toEqual({ ok: true, value: null })
  expect(invoke(PROJECT_IPC_CHANNELS.LIST_OWNER_PLAN_HISTORY, { projectId: p.id })).toEqual({ ok: true, value: [] })
  expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, request)).toMatchObject({ ok: true, value: { revision: 1, state: 'proposed', origin: 'manual', actor: 'local-user' } })
  expect(invoke(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT, { projectId: p.id, expectedGoalRevision: 1, expectedRevision: 1 })).toMatchObject({ ok: true, value: { revision: 2, state: 'confirmed', planVersion: 1 } })
  const history = invoke(PROJECT_IPC_CHANNELS.LIST_OWNER_PLAN_HISTORY, { projectId: p.id })
  expect(history.ok && (history.value as ProjectOwnerPlanDraft[]).map((p) => p.state)).toEqual(['proposed', 'confirmed'])
})

test('冲突结构化类别跨Electron不依赖错误字符串；不自动重试', () => {
  const { p, request } = fixture()
  invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, request)
  expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, request)).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(invoke(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT, { projectId: p.id, expectedRevision: 1, expectedGoalRevision: 2 })).toMatchObject({ ok: false, error: { code: 'conflict' } })
  store.updateProject(p.id, { description: '来源变更' })
  expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, { ...request, expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(plans.listProjectOwnerPlanHistory(p.id)).toHaveLength(1)
})

test('外层actor/权限/授权/未知字段、无效版本、错误主体全部拒绝', () => {
  const { p, request } = fixture()
  for (const input of [null, [], { projectId: '' }, { projectId: 'missing' }, { projectId: p.id, taskId: null }, { projectId: p.id, actor: 'system' }, { projectId: p.id, grantId: 'fake' }]) {
    expect(invoke(PROJECT_IPC_CHANNELS.GET_OWNER_PLAN_DRAFT, input)).toMatchObject({ ok: false, error: { code: 'failed' } })
  }
  for (const field of ['actor', 'grantId', 'permissionMode', 'goalVersion', 'employeeId', 'mode']) {
    expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, { ...request, [field]: 'fake' })).toMatchObject({ ok: false, error: { code: 'failed' } })
    expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, { ...request, input: { ...request.input, [field]: 'fake' } })).toMatchObject({ ok: false, error: { code: 'failed' } })
  }
  expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, { ...request, expectedGoalRevision: '1' })).toMatchObject({ ok: false })
  expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, { ...request, expectedRevision: -1 })).toMatchObject({ ok: false })
  expect(invoke(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT, { projectId: p.id, expectedGoalRevision: 1, expectedRevision: 0, actor: 'local-user' })).toMatchObject({ ok: false })
})

test('单任务保存与确认绑定真实主体，不允许跨项目或修改项目目标', () => {
  const { p, request } = fixture()
  const task = store.createTask(p.id, { title: '单任务', description: '' })
  goals.saveProjectOwnerGoalDraft(p.id, 0, { objective: '单任务成果' }, task.id)
  const taskRequest = { ...request, taskId: task.id, input: { ...request.input, expectedContextFingerprint: plans.getProjectOwnerPlanningContext(p.id, task.id).fingerprint } }
  expect(invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, taskRequest)).toMatchObject({ ok: true, value: { taskId: task.id } })
  expect(invoke(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT, { projectId: p.id, taskId: task.id, expectedGoalRevision: 1, expectedRevision: 1 })).toMatchObject({ ok: true, value: { state: 'confirmed' } })
  expect(plans.getProjectOwnerPlanDraft(p.id)).toBeNull()
  const other = store.createProject({ title: '另一项目', description: '' })
  expect(invoke(PROJECT_IPC_CHANNELS.GET_OWNER_PLAN_DRAFT, { projectId: other.id, taskId: task.id })).toMatchObject({ ok: false })
})

test('IPC保存/确认/历史/来源读取不产生执行、grant、项目链记录或权威任务', () => {
  const { p, request } = fixture()
  const count = (table: string) => store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()
  const tables = ['tasks', 'agent_executions', 'pilot_intents', 'pilot_commands', 'pilot_runtime_grants', 'project_chain_revisions']
  const before = tables.map(count)
  invoke(PROJECT_IPC_CHANNELS.SAVE_OWNER_PLAN_DRAFT, request)
  invoke(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PLAN_DRAFT, { projectId: p.id, expectedGoalRevision: 1, expectedRevision: 1 })
  invoke(PROJECT_IPC_CHANNELS.LIST_OWNER_PLAN_HISTORY, { projectId: p.id })
  expect(tables.map(count)).toEqual(before)
  expect(goals.getProjectOwnerGoalDraft(p.id)?.revision).toBe(1)
})
