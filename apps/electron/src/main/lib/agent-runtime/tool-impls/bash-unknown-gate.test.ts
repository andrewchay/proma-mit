import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../../testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'bash-unknown-gate-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())

/** 每次用例控制 Bash 的终止证据：{ status, pgid } 直接决定结果是否按未知登记。 */
let evidence: { status: 'exited' | 'terminated' | 'unconfirmed'; pgid: number; exitCode?: number | null }
let launches = 0

mock.module('./tool-utils.ts', () => ({
  formatToolError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  truncateOutput: (value: string) => value,
  requiresOwnerToolGate: () => false,
}))
mock.module('./bash-sandbox.ts', () => ({
  prepareBashSandbox: async () => ({ argv: [], env: {}, gitWasPresent: true, assertLaunchSafe: async () => undefined }),
  quarantineNewGitArtifacts: async () => undefined,
}))
mock.module('./bash-termination.ts', () => ({
  describeBashTermination: () => (evidence.status === 'exited' ? undefined : '命令已中止，进程组已确认退出'),
  runBashCommand: async () => {
    launches += 1
    const result = { stdout: 'GRAVITAS_BASH_OK', stderr: '', evidence }
    if (evidence.status === 'exited') return result
    return { ...result, stdout: '', failure: { message: '命令已中止', isError: true as const } }
  },
}))
mock.module('../../project-owner-execution-gates', () => ({
  assertBoundToolSession: () => undefined,
  assertToolAllowedForSessionPurpose: () => undefined,
}))

const { executeBashToolOnPlatform } = await import('./bash-tool')
const { __resetUnknownActionCacheForTest, listPendingUnknownActions } = await import('../unknown-action-store')

/** 每个用例独立 sessionId：未知记录会落盘并在下次读取时重载，跨用例共用会互相干扰。 */
const ctxFor = (name: string) => ({ sessionId: `bash-unknown-${name}`, cwd: '/tmp/bash-unknown' })

beforeAll(() => { __resetUnknownActionCacheForTest() })
beforeEach(() => { __resetUnknownActionCacheForTest(); launches = 0 })
afterAll(() => {
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

test('Given 命令超时中止且进程组已确认退出 When 再次执行同一命令 Then 拦截且要求用户核对', async () => {
  const ctx = ctxFor('timeout')
  evidence = { status: 'terminated', pgid: 4242 }
  const first = await executeBashToolOnPlatform({ command: 'touch marker' }, ctx, 'darwin')
  expect(first.isError).toBe(true)
  expect(launches).toBe(1)
  expect(await listPendingUnknownActions(ctx.sessionId)).toHaveLength(1)

  const second = await executeBashToolOnPlatform({ command: 'touch marker' }, ctx, 'darwin')
  expect(second.isError).toBe(true)
  expect(second.content).toContain('结果未知')
  expect(second.content).toContain('ResolveUnknownAction')
  // 被拦截时不再派发命令。
  expect(launches).toBe(1)
})

test('Given 无法启动沙箱进程 When 再次执行同一命令 Then 不按未知登记且允许重试', async () => {
  const ctx = ctxFor('boot-failed')
  evidence = { status: 'unconfirmed', pgid: -1 }
  const first = await executeBashToolOnPlatform({ command: 'touch boot-failed' }, ctx, 'darwin')
  expect(first.isError).toBe(true)
  expect(await listPendingUnknownActions(ctx.sessionId)).toHaveLength(0)

  const second = await executeBashToolOnPlatform({ command: 'touch boot-failed' }, ctx, 'darwin')
  expect(second.isError).toBe(true)
  expect(second.content).not.toContain('结果未知')
  expect(launches).toBe(2)
})

test('Given 命令正常退出 When 再次执行同一命令 Then 不登记未知也不拦截', async () => {
  const ctx = ctxFor('exit-ok')
  evidence = { status: 'exited', pgid: 4243, exitCode: 0 }
  const first = await executeBashToolOnPlatform({ command: 'printf ok' }, ctx, 'darwin')
  expect(first.isError).toBeFalsy()
  expect(first.content).toContain('GRAVITAS_BASH_OK')
  expect(await listPendingUnknownActions(ctx.sessionId)).toHaveLength(0)

  const second = await executeBashToolOnPlatform({ command: 'printf ok' }, ctx, 'darwin')
  expect(second.isError).toBeFalsy()
  expect(launches).toBe(2)
})

test('Given 同一会话另一条命令 When 前一条处于未知 Then 不受影响', async () => {
  const ctx = ctxFor('sibling-command')
  evidence = { status: 'terminated', pgid: 4244 }
  await executeBashToolOnPlatform({ command: 'sleep 60' }, ctx, 'darwin')
  expect(await listPendingUnknownActions(ctx.sessionId)).toHaveLength(1)

  evidence = { status: 'exited', pgid: 4245, exitCode: 0 }
  const other = await executeBashToolOnPlatform({ command: 'printf other' }, ctx, 'darwin')
  expect(other.isError).toBeFalsy()
})

test('Given 另一会话执行相同命令 When 前一会话存在未知记录 Then 互不影响', async () => {
  const ctx = ctxFor('cross-session')
  evidence = { status: 'terminated', pgid: 4246 }
  await executeBashToolOnPlatform({ command: 'touch shared' }, ctx, 'darwin')

  evidence = { status: 'exited', pgid: 4247, exitCode: 0 }
  const other = await executeBashToolOnPlatform({ command: 'touch shared' }, ctxFor('cross-session-other'), 'darwin')
  expect(other.isError).toBeFalsy()
})
