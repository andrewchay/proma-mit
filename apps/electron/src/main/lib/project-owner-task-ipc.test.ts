import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-materialization-ipc-')),
  previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const { registerProjectOwnerTaskIpcHandlers } = await import('./project-owner-task-ipc')
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
registerProjectOwnerTaskIpcHandlers({
  handle: (name, handler) => {
    handlers.set(name, handler)
  },
})
beforeAll(async () => {
  await store.initProjectDb()
})
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
test('四个暂停关联API注册，不注册active发行/费用或运行命令', () => {
  expect([...handlers.keys()].sort()).toEqual(
    [
      PROJECT_IPC_CHANNELS.GET_OWNER_TASK_MATERIALIZATION,
      PROJECT_IPC_CHANNELS.LIST_OWNER_TASK_MATERIALIZATION_HISTORY,
      PROJECT_IPC_CHANNELS.PREVIEW_OWNER_TASK_MATERIALIZATION,
      PROJECT_IPC_CHANNELS.MATERIALIZE_OWNER_TASKS,
    ].sort(),
  )
})
test('读取不接受客户端actor/grant/跨形状参数，错误完整编码', () => {
  for (const name of [
    PROJECT_IPC_CHANNELS.GET_OWNER_TASK_MATERIALIZATION,
    PROJECT_IPC_CHANNELS.LIST_OWNER_TASK_MATERIALIZATION_HISTORY,
  ]) {
    for (const input of [
      null,
      [],
      { projectId: 'p', actor: 'remote-admin' },
      { projectId: 'p', grantId: 'fake' },
      { projectId: 1 },
      { projectId: 'p', taskId: '' },
    ]) {
      const result = handlers.get(name)!(undefined, input)
      expect(result).toMatchObject({ ok: false, error: { code: 'failed' } })
    }
  }
})
test('preview/save夹带active或越权主体拒绝，没有预算/任务副作用', () => {
  for (const name of [
    PROJECT_IPC_CHANNELS.PREVIEW_OWNER_TASK_MATERIALIZATION,
    PROJECT_IPC_CHANNELS.MATERIALIZE_OWNER_TASKS,
  ]) {
    expect(
      handlers.get(name)!(undefined, { projectId: 'p', state: 'active', input: {} }),
    ).toMatchObject({ ok: false })
    expect(
      handlers.get(name)!(undefined, { projectId: 'p', actor: 'remote-user', input: {} }),
    ).toMatchObject({ ok: false })
    expect(
      handlers.get(name)!(undefined, {
        projectId: 'p',
        input: { actor: 'remote-user' },
        previewFingerprint: 'x',
      }),
    ).toMatchObject({ ok: false })
  }
  for (const table of [
    'tasks',
    'pilot_runtime_grants',
    'pilot_commands',
    'agent_executions',
    'pilot_request_reservations',
    'project_owner_execution_preparations',
  ])
    expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({
      c: 0,
    })
})
