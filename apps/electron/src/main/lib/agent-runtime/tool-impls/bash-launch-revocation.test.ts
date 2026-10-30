import { expect, mock, test } from 'bun:test'

let authorized = true
let launches = 0
let unblock: (() => void) | undefined
let reached: (() => void) | undefined
const checking = new Promise<void>(resolve => { reached = resolve })
const waitForCheck = new Promise<void>(resolve => { unblock = resolve })

mock.module('./tool-utils.ts', () => ({
  formatToolError: (error: unknown) => error instanceof Error ? error.message : String(error),
  truncateOutput: (value: string) => value,
  requiresOwnerToolGate: () => true,
}))
mock.module('./bash-sandbox.ts', () => ({
  prepareBashSandbox: async () => ({
    argv: [], env: {}, gitWasPresent: true,
    assertLaunchSafe: async () => { reached?.(); await waitForCheck },
  }),
  quarantineNewGitArtifacts: async () => undefined,
}))
mock.module('./bash-termination.ts', () => ({
  describeBashTermination: () => undefined,
  runBashCommand: async () => { launches++; return { stdout: '', stderr: '', evidence: {} } },
}))
mock.module('../../project-owner-execution-gates', () => ({
  assertToolAllowedForSessionPurpose: () => { if (!authorized) throw new Error('授权已撤销') },
}))

const { executeBashToolOnPlatform } = await import('./bash-tool')

test('Given 启动检查期间撤销授权 When 检查结束 Then 拒绝派发 shell', async () => {
  const resultPromise = executeBashToolOnPlatform({ command: 'echo hello' }, { cwd: '/tmp', sessionId: 'owner-test' }, 'darwin')
  await checking
  authorized = false
  unblock?.()
  const result = await resultPromise
  expect(result.isError).toBe(true)
  expect(result.content).toContain('授权已撤销')
  expect(launches).toBe(0)
})
