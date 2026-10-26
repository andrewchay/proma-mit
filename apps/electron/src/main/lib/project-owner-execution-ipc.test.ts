import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-preparation-ipc-')),
  previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const { registerProjectOwnerExecutionIpcHandlers } = await import('./project-owner-execution-ipc')
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
registerProjectOwnerExecutionIpcHandlers({
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
test('Owner准备/手动命令API与自主Scheduler只读状态API注册；Renderer没有自主派发入口', () => {
  expect([...handlers.keys()].sort()).toEqual([
    PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_PREPARATION,
    PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_PREPARATION_HISTORY,
    PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_PREPARATION,
    PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_PREPARATION,
    PROJECT_IPC_CHANNELS.GET_OWNER_AUTONOMOUS_SCHEDULE_STATUS,
    PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_COMMAND_ACK,
    PROJECT_IPC_CHANNELS.QUEUE_OWNER_EXECUTION_COMMAND,
    PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_COMMANDS,
    PROJECT_IPC_CHANNELS.DISPATCH_OWNER_EXECUTION_COMMAND,
    PROJECT_IPC_CHANNELS.CANCEL_QUEUED_OWNER_EXECUTION_COMMAND,
    PROJECT_IPC_CHANNELS.PREVIEW_OWNER_PREFLIGHT_RECONCILIATION,
    PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PREFLIGHT_RECONCILIATION,
  ].sort())
})
test('读取不接受客户端actor/grant/跨形状参数，错误完整编码', async () => {
  for (const name of [
    PROJECT_IPC_CHANNELS.GET_OWNER_AUTONOMOUS_SCHEDULE_STATUS,
    PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_PREPARATION,
    PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_PREPARATION_HISTORY,
  ]) {
    for (const input of [
      null,
      [],
      { projectId: 'p', actor: 'remote-admin' },
      { projectId: 'p', grantId: 'fake' },
      { projectId: 1 },
      { projectId: 'p', taskId: '' },
    ]) {
      const result = await handlers.get(name)!(undefined, input)
      expect(result).toMatchObject({ ok: false, error: { code: 'failed' } })
    }
  }
})
test('preview/save夹带active或越权主体拒绝，没有预算/任务副作用', async () => {
  for (const name of [
    PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_PREPARATION,
    PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_PREPARATION,
  ]) {
    expect(
      await handlers.get(name)!(undefined, { projectId: 'p', state: 'active', input: {} }),
    ).toMatchObject({ ok: false })
    expect(
      await handlers.get(name)!(undefined, { projectId: 'p', actor: 'remote-user', input: {} }),
    ).toMatchObject({ ok: false })
    expect(
      await handlers.get(name)!(undefined, {
        projectId: 'p',
        input: { actor: 'remote-user' },
        previewFingerprint: 'x',
      }),
    ).toMatchObject({ ok: false })
  }
  expect(await handlers.get(PROJECT_IPC_CHANNELS.DISPATCH_OWNER_EXECUTION_COMMAND)!(undefined, { commandId: 'x', ackFingerprint: 'x', acknowledgeExecution: true, executionId: 'caller-chosen' })).toMatchObject({ ok: false })
  expect(await handlers.get(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_PREFLIGHT_RECONCILIATION)!(undefined, { projectId: 'p', commandId: 'x', actor: 'remote-user' })).toMatchObject({ ok: false })
  expect(await handlers.get(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_PREFLIGHT_RECONCILIATION)!(undefined, { projectId: 'p', commandId: 'x', confirmedFingerprint: 'a'.repeat(64), providerConsoleCheckedNoUsage: false })).toMatchObject({ ok: false })
  for (const table of [
    'tasks',
    'pilot_runtime_grants',
    'pilot_commands',
    'agent_executions',
    'pilot_request_reservations',
    'project_owner_execution_preparations',
    'project_owner_execution_preflight_rejections',
    'project_owner_execution_preflight_reconciliations',
  ])
    expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({
      c: 0,
    })
})
