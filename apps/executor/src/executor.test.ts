import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSandboxArgs, executeIsolatedCommand, type ExecutorRequest } from './executor.ts'

const root = mkdtempSync(join(tmpdir(), 'gravitas-executor-'))
const a = join(root, 'a')
const b = join(root, 'b')
mkdirSync(a); mkdirSync(b)
writeFileSync(join(b, 'private.txt'), 'SYNTHETIC-OTHER-TENANT')
afterAll(() => rmSync(root, { recursive: true, force: true }))
const policy = { workspaceRoot: root, allowedCommands: ['bun', 'printf'] }
const request: ExecutorRequest = { taskId: 'task-1', workspaceDir: a, command: 'printf', args: ['ok'], timeoutMs: 5_000, maxOutputBytes: 1024 }

describe('隔离执行器', () => {
  test('Given 越界路径或整个共享根目录 When 请求执行 Then 在启动前拒绝', async () => {
    await expect(executeIsolatedCommand({ ...request, workspaceDir: root }, policy)).rejects.toThrow('挂载范围')
    await expect(executeIsolatedCommand({ ...request, workspaceDir: tmpdir() }, policy)).rejects.toThrow('挂载范围')
    await expect(executeIsolatedCommand({ ...request, command: 'sh' }, policy)).rejects.toThrow('allowlist')
  })
  test('Given 沙箱参数 When 构建 Then 仅绑定当前工作区并隔离网络和环境', () => {
    const args = buildSandboxArgs(3, request)
    expect(args).toContain('--unshare-all')
    expect(args).toContain('--clearenv')
    expect(args).not.toContain(root)
    expect(args).not.toContain(b)
    expect(args.slice(args.indexOf('--bind-fd'), args.indexOf('--bind-fd') + 3)).toEqual(['--bind-fd', '3', '/workspace'])
  })
  test.skipIf(process.platform === 'linux' && existsSync('/usr/bin/bwrap'))('Given 无沙箱平台 When 执行 Then 不回退宿主机', async () => {
    await expect(executeIsolatedCommand(request, policy)).rejects.toThrow('bubblewrap')
  })
})

const linux = process.platform === 'linux' && existsSync('/usr/bin/bwrap')
describe.skipIf(!linux)('Linux 真沙箱验收', () => {
  test('Given 当前工作区 When 执行 Then 可写入并保留结果', async () => {
    const result = await executeIsolatedCommand({ ...request, command: 'bun', args: ['-e', 'await Bun.write("result.txt","ok");console.log("done")'] }, policy)
    expect(result.exitCode).toBe(0)
    expect(existsSync(join(a, 'result.txt'))).toBe(true)
  })
  test('Given 其他租户文件和凭证环境 When 运行任意代码 Then 无法读取', async () => {
    process.env.GRAVITAS_EXECUTOR_TEST_SECRET = 'SYNTHETIC-TOKEN'
    try {
      const code = 'console.log(await Bun.file(' + JSON.stringify(join(b, 'private.txt')) + ').exists());console.log(process.env.GRAVITAS_EXECUTOR_TEST_SECRET ?? "absent")'
      const result = await executeIsolatedCommand({ ...request, command: 'bun', args: ['-e', code] }, policy)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('false\nabsent')
    } finally { delete process.env.GRAVITAS_EXECUTOR_TEST_SECRET }
  })
  test('Given 长任务 When 超时 Then 终止整个 PID namespace', async () => {
    const result = await executeIsolatedCommand({ ...request, command: 'bun', args: ['-e', 'Bun.spawn(["bun","-e","setInterval(()=>{},1000)"]);setInterval(()=>{},1000)'], timeoutMs: 300 }, policy)
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })
  test('Given 运行中任务 When 取消 Then 返回 AbortError', async () => {
    const controller = new AbortController()
    const pending = executeIsolatedCommand({ ...request, command: 'bun', args: ['-e', 'setInterval(()=>{},1000)'] }, policy, controller.signal)
    setTimeout(() => controller.abort(), 300)
    await expect(pending).rejects.toThrow('任务已取消')
  })
})

test.skipIf(!linux)('Given 容器本地 HTTP 服务 When 沙箱尝试访问 Then 网络不可达', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('outer-secret') })
  try {
    const code = 'try { await fetch("http://127.0.0.1:' + server.port + '", {signal:AbortSignal.timeout(500)});console.log("leaked") } catch {console.log("blocked")}'
    const result = await executeIsolatedCommand({ ...request, command: 'bun', args: ['-e', code] }, policy)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('blocked')
  } finally { server.stop(true) }
})
