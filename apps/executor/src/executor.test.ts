import { describe, expect, test } from 'bun:test'
import { executeIsolatedCommand } from './executor.ts'

describe('隔离执行器', () => {
  test('given an allowlisted binary in the mounted workspace then it executes without a shell', async () => {
    const result = await executeIsolatedCommand({
      taskId: 'task-1', workspaceDir: '/tmp', command: 'printf', args: ['ok'], timeoutMs: 1_000, maxOutputBytes: 1_024,
    }, { workspaceRoot: '/tmp', allowedCommands: ['printf'] })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('ok')
    expect(result.timedOut).toBeFalse()
  })

  test('given a non-allowlisted command or outside workspace then it rejects before spawning', async () => {
    await expect(executeIsolatedCommand({
      taskId: 'task-1', workspaceDir: '/tmp', command: 'sh', args: ['-c', 'id'], timeoutMs: 1_000, maxOutputBytes: 1_024,
    }, { workspaceRoot: '/tmp', allowedCommands: ['printf'] })).rejects.toThrow('allowlist')
    await expect(executeIsolatedCommand({
      taskId: 'task-1', workspaceDir: '/var/tmp', command: 'printf', args: ['ok'], timeoutMs: 1_000, maxOutputBytes: 1_024,
    }, { workspaceRoot: '/tmp', allowedCommands: ['printf'] })).rejects.toThrow('挂载范围')
  })
})
