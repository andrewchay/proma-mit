import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_IPC_CHANNELS, type ProjectOwnerGoalDraft, type ProjectOwnerGoalResult } from '@gravitas/shared'
import { closeProjectDb, createProject, createTask, getProjectDb, initProjectDb } from './project-sqlite-store'
import { registerProjectOwnerGoalIpcHandlers } from './project-owner-goal-ipc'
import { createStore } from 'jotai/vanilla'
import { acknowledgeOwnerGoalComparisonAtom, editOwnerGoalAtom, getOwnerGoalEditor, loadOwnerGoalAtom,
  ownerGoalApiAtom, ownerGoalEditorsAtom, saveOwnerGoalAtom } from '../../renderer/atoms/project-owner-goal-atoms'

const dir = mkdtempSync(join(tmpdir(), 'owner-goal-ipc-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = dir
  await initProjectDb()
  registerProjectOwnerGoalIpcHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } })
})
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})
function invoke(channel: string, request: unknown): ProjectOwnerGoalResult<ProjectOwnerGoalDraft | null> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('未注册草案IPC')
  return handler({}, request) as ProjectOwnerGoalResult<ProjectOwnerGoalDraft | null>
}
function fixture() { return createProject({ title: 'IPC目标夹具', description: '' }) }
const getChannel = PROJECT_IPC_CHANNELS.GET_OWNER_GOAL_DRAFT
const saveChannel = PROJECT_IPC_CHANNELS.SAVE_OWNER_GOAL_DRAFT

test('IPC空读及保存返回结构化结果，记录仍为无授权draft', () => {
  const project = fixture()
  expect(invoke(getChannel, { projectId: project.id })).toEqual({ ok: true, value: null })
  const result = invoke(saveChannel, { projectId: project.id, expectedRevision: 0, input: { objective: '可评审成果' } })
  expect(result).toMatchObject({ ok: true, value: { revision: 1, actor: 'local-user', state: 'draft' } })
  for (const table of ['agent_executions', 'pilot_commands', 'pilot_runtime_grants']) {
    expect(getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({ c: 0 })
  }
})
test('IPC旧版本冲突保留类别，不依赖Electron传递Error字段', () => {
  const project = fixture()
  const request = { projectId: project.id, expectedRevision: 0, input: { objective: '目标' } }
  invoke(saveChannel, request)
  expect(invoke(saveChannel, request)).toMatchObject({ ok: false, error: { code: 'conflict' } })
})
test('IPC严格拒绝外层actor/权限/版本/未知字段与无效主体', () => {
  const project = fixture()
  for (const request of [null, [], { projectId: project.id, actor: 'system' }, { projectId: project.id, grantId: 'fake' }, { projectId: 'missing' }, { projectId: project.id, taskId: null }]) {
    expect(invoke(getChannel, request)).toMatchObject({ ok: false, error: { code: 'failed' } })
  }
  expect(invoke(saveChannel, { projectId: project.id, expectedRevision: 0, input: { objective: '目标' }, actor: 'system' })).toMatchObject({ ok: false })
  expect(invoke(saveChannel, { projectId: project.id, expectedRevision: 0, input: { objective: '目标', permissionMode: 'allow-all' } })).toMatchObject({ ok: false })
})
test('IPC单任务目标不允许跨项目，project与task草案不互相覆盖', () => {
  const first = fixture(); const second = fixture()
  const task = createTask(first.id, { title: '任务目标', description: '' })
  expect(invoke(saveChannel, { projectId: second.id, taskId: task.id, expectedRevision: 0, input: { objective: '任务目标' } })).toMatchObject({ ok: false })
  expect(invoke(saveChannel, { projectId: first.id, taskId: task.id, expectedRevision: 0, input: { objective: '任务目标' } })).toMatchObject({ ok: true })
  expect(invoke(getChannel, { projectId: first.id })).toEqual({ ok: true, value: null })
})

test('Jotai→IPC处理器→数据库保存及冲突恢复使用真实草案服务（非真实Electron传输）', async () => {
  const project = fixture(); const subject = { projectId: project.id }
  const store = createStore()
  store.set(ownerGoalApiAtom, {
    getOwnerGoalDraft: async (target) => invoke(getChannel, target),
    saveOwnerGoalDraft: async (request) => {
      const response = invoke(saveChannel, request)
      if (!response.ok) return response
      if (!response.value) throw new Error('保存未返回草案')
      return { ok: true, value: response.value }
    },
  })
  const read = () => getOwnerGoalEditor(store.get(ownerGoalEditorsAtom), subject)
  await store.set(loadOwnerGoalAtom, subject)
  store.set(editOwnerGoalAtom, { subject, patch: { objective: '第一个用户目标' } })
  await store.set(saveOwnerGoalAtom, subject)
  expect(read().snapshot?.revision).toBe(1); expect(read().dirty).toBe(false)
  invoke(saveChannel, { ...subject, expectedRevision: 1, input: { objective: '另一个窗口的目标' } })
  store.set(editOwnerGoalAtom, { subject, patch: { objective: '我的未保存修改' } })
  await store.set(saveOwnerGoalAtom, subject)
  expect(read().conflict).toBe(true); expect(read().objective).toBe('我的未保存修改')
  await store.set(loadOwnerGoalAtom, subject)
  expect(read().snapshot?.goal.objective).toBe('另一个窗口的目标')
  expect(read().requiresReview).toBe(true)
  store.set(acknowledgeOwnerGoalComparisonAtom, subject)
  await store.set(saveOwnerGoalAtom, subject)
  expect(read().snapshot?.revision).toBe(3); expect(read().snapshot?.goal.objective).toBe('我的未保存修改')
  expect(getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_revisions WHERE project_id = ?').get(project.id)).toEqual({ c: 3 })
})
