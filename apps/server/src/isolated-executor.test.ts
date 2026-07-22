import { describe, expect, test } from 'bun:test'
import { DisabledIsolatedExecutor, HttpIsolatedExecutor } from './isolated-executor.ts'

describe('隔离执行器边界', () => {
  test('given no configured worker then API process refuses host shell execution', async () => {
    const executor = new DisabledIsolatedExecutor()
    await expect(executor.execute({
      taskId: 'task-1', workspaceDir: '/workspace', command: 'sh', args: ['-c', 'id'], timeoutMs: 1_000, maxOutputBytes: 1_024,
    }, new AbortController().signal)).rejects.toThrow('禁止直接执行 Shell')
  })

  test('given a configured executor endpoint then API process forwards only the structured request', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        expect(request.headers.get('authorization')).toBe('Bearer executor-token')
        expect(await request.json()).toEqual({ taskId: 'task-1', workspaceDir: '/data/workspaces/a', command: 'git', args: ['status'], timeoutMs: 1_000, maxOutputBytes: 1_024 })
        return Response.json({ exitCode: 0, stdout: 'clean', stderr: '', timedOut: false })
      },
    })
    try {
      const executor = new HttpIsolatedExecutor(`http://127.0.0.1:${server.port}`, 'executor-token')
      await expect(executor.execute({ taskId: 'task-1', workspaceDir: '/data/workspaces/a', command: 'git', args: ['status'], timeoutMs: 1_000, maxOutputBytes: 1_024 }, new AbortController().signal))
        .resolves.toEqual({ exitCode: 0, stdout: 'clean', stderr: '', timedOut: false })
    } finally {
      server.stop(true)
    }
  })
})
