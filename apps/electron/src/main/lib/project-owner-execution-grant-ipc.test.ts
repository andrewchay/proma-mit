import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-grant-ipc-')),
  previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const { registerProjectOwnerExecutionGrantIpcHandlers } = await import(
  './project-owner-execution-grant-ipc'
)
const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
registerProjectOwnerExecutionGrantIpcHandlers({
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
test('六个授权账本API注册，不注册任何active派工/命令/占额/停止类通道', () => {
  expect([...handlers.keys()].sort()).toEqual(
    [
      PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_GRANT,
      PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_GRANT_HISTORY,
      PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_ISSUE,
      PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_ISSUE,
      PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_REVOKE,
      PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_REVOKE,
    ].sort(),
  )
  // 显式对照：既有的派工/占额/停止通道一律不得出现在本注册器
  for (const forbidden of [
    PROJECT_IPC_CHANNELS.PREVIEW_PILOT_GRANT,
    PROJECT_IPC_CHANNELS.CONFIRM_PILOT_GRANT,
    PROJECT_IPC_CHANNELS.PREVIEW_PILOT_GRANT_PAUSE,
    PROJECT_IPC_CHANNELS.CONFIRM_PILOT_GRANT_PAUSE,
  ])
    expect(handlers.has(forbidden)).toBe(false)
})
test('读取不接受客户端actor/grant/input等跨形状参数，错误完整编码', async () => {
  for (const name of [
    PROJECT_IPC_CHANNELS.GET_OWNER_EXECUTION_GRANT,
    PROJECT_IPC_CHANNELS.LIST_OWNER_EXECUTION_GRANT_HISTORY,
  ]) {
    for (const input of [
      null,
      [],
      { projectId: 'p', actor: 'remote-admin' },
      { projectId: 'p', grantId: 'fake' },
      { projectId: 'p', input: {} },
      { projectId: 1 },
      { projectId: 'p', taskId: '' },
    ]) {
      const result = await handlers.get(name)!(undefined, input)
      expect(result).toMatchObject({ ok: false, error: { code: 'failed' } })
    }
  }
})
test('发行confirm白名单只接受projectId/taskId/input/preview/confirmedFingerprint，夹带越权字段拒绝', async () => {
  const channel = PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_ISSUE
  for (const request of [
    null,
    { projectId: 'p', input: {}, preview: {}, confirmedFingerprint: 'a'.repeat(64), actor: 'remote-admin' },
    { projectId: 'p', input: {}, preview: {}, confirmedFingerprint: 'a'.repeat(64), state: 'active' },
    { projectId: 'p', input: { actor: 'remote-user' }, preview: {}, confirmedFingerprint: 'a'.repeat(64) },
    { projectId: 'p', input: {}, preview: {}, confirmedFingerprint: 'a'.repeat(64), grantId: 'x' },
    { projectId: 'p', input: {}, confirmedFingerprint: 'a'.repeat(64), previewFingerprint: 'x' },
  ])
    expect(await handlers.get(channel)!(undefined, request)).toMatchObject({ ok: false })
})
test('撤权两阶段白名单只接受grantId系字段，命令/占额字段拒绝且零副作用', async () => {
  for (const [channel, request] of [
    [PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_REVOKE, { projectId: 'p', grantId: 'g', input: {} }],
    [PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_REVOKE, { projectId: 'p', grantId: 'g', actor: 'remote-admin' }],
    [PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_REVOKE, { projectId: 'p' }],
    [
      PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_REVOKE,
      { projectId: 'p', grantId: 'g', confirmedFingerprint: 'a'.repeat(64), preview: {} },
    ],
    [
      PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_REVOKE,
      { projectId: 'p', grantId: 'g', confirmedFingerprint: 'a'.repeat(64), actor: 'remote-admin' },
    ],
    [PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_REVOKE, { projectId: 'p', grantId: 'g' }],
  ] as const)
    expect(await handlers.get(channel)!(undefined, request)).toMatchObject({ ok: false })
  for (const table of [
    'tasks',
    'pilot_runtime_grants',
    'pilot_commands',
    'agent_executions',
    'pilot_request_reservations',
    'project_owner_execution_grants',
    'project_owner_execution_grant_decisions',
  ])
    expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({ c: 0 })
})
test('发行preview/confirm对格式有效但主体不存在的请求返回failed/conflict，零写入', async () => {
  const input = { requestId: 'r1', expectedRevalidationRevision: 0, expectedPolicyRevision: 1 }
  expect(
    await handlers.get(PROJECT_IPC_CHANNELS.PREVIEW_OWNER_EXECUTION_GRANT_ISSUE)!(undefined, {
      projectId: 'p-missing',
      input,
    }),
  ).toMatchObject({ ok: false })
  expect(
    await handlers.get(PROJECT_IPC_CHANNELS.CONFIRM_OWNER_EXECUTION_GRANT_ISSUE)!(undefined, {
      projectId: 'p-missing',
      input,
      preview: {},
      confirmedFingerprint: 'a'.repeat(64),
    }),
  ).toMatchObject({ ok: false })
  expect(
    store
      .getProjectDb()
      .prepare('SELECT COUNT(*) AS c FROM project_owner_execution_grants')
      .get(),
  ).toEqual({ c: 0 })
})
