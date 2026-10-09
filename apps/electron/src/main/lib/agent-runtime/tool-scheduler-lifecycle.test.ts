import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const dir = mkdtempSync(join(tmpdir(), 'gravitas-scheduler-life-'))
process.env.PROMA_TEST_CONFIG_DIR = dir
mock.module('electron', () => buildElectronMock())
const { bindCoreToolEffects } = await import('./tool-effects')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')
const { createReadToolDefinition, executeReadTool } = await import('./tool-impls/read-tool')
const svc = await import('./tool-scheduler-service')
const { runGuardedToolCall, setToolSchedulerDisabled, toolExecutionScheduler } = svc

beforeAll(() => { mkdirSync(join(dir, 'work')); writeFileSync(join(dir, 'work', 'r.txt'), 'r') })
afterAll(() => {
  setToolSchedulerDisabled(false)
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(dir, { recursive: true, force: true })
})
const cwd = join(dir, 'work')
const write = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const read = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const ctx = { cwd, sessionId: 'life-fixture' }
const fakeTool = (name: string) => bindCoreToolEffects({ name, description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })

describe('E04 重试策略', () => {
  test('幂等读可按策略重试；默认不重试', async () => {
    let attempts = 0
    const run = () => runGuardedToolCall({
      tool: read, args: { file_path: 'r.txt' }, ctx,
      execute: async () => { attempts += 1; if (attempts === 1) throw new Error('瞬时网络错误'); return { content: 'ok' } },
      retry: { maxAttempts: 3 },
    })
    await expect(run()).resolves.toEqual({ content: 'ok' })
    expect(attempts).toBe(2)
    let once = 0
    await expect(runGuardedToolCall({
      tool: read, args: { file_path: 'r.txt' }, ctx,
      execute: async () => { once += 1; throw new Error('瞬时网络错误') },
    })).rejects.toThrow('瞬时网络错误')
    expect(once).toBe(1)
  })
  test('写与 unknown 绝不自动重放，即使配置了重试', async () => {
    let wAttempts = 0
    await expect(runGuardedToolCall({
      tool: write, args: { file_path: 'w.txt', content: 'x' }, ctx,
      execute: async () => { wAttempts += 1; throw new Error('写失败') },
      retry: { maxAttempts: 3 },
    })).rejects.toThrow('写失败')
    expect(wAttempts).toBe(1)
    let uAttempts = 0
    await expect(runGuardedToolCall({
      tool: fakeTool('McpExt'), args: {}, ctx,
      execute: async () => { uAttempts += 1; throw new Error('外部调用失败') },
      retry: { maxAttempts: 3 },
    })).rejects.toThrow('外部调用失败')
    expect(uAttempts).toBe(1)
  })
  test('shouldRetry 返回 false 时不重试；中止错误永不重试', async () => {
    let n = 0
    await expect(runGuardedToolCall({
      tool: read, args: { file_path: 'r.txt' }, ctx,
      execute: async () => { n += 1; throw new Error('业务错误') },
      retry: { maxAttempts: 3, shouldRetry: () => false },
    })).rejects.toThrow('业务错误')
    expect(n).toBe(1)
    let a = 0
    const controller = new AbortController()
    controller.abort()
    await expect(runGuardedToolCall({
      tool: read, args: { file_path: 'r.txt' }, ctx, signal: controller.signal,
      execute: async () => { a += 1; return { content: 'x' } },
      retry: { maxAttempts: 3 },
    })).rejects.toThrow()
    expect(a).toBe(0)
  })
})

describe('E04 禁用与硬底线、重启复用', () => {
  test('禁用后退化为全串行，但锁仍持有（写不能插队）', async () => {
    setToolSchedulerDisabled(true)
    try {
      const log: string[] = []
      const r1 = runGuardedToolCall({ tool: read, args: { file_path: 'r.txt' }, ctx, execute: async () => { log.push('start:r1'); await Bun.sleep(40); log.push('end:r1'); return { content: '1' } } })
      const r2 = runGuardedToolCall({ tool: read, args: { file_path: 'r.txt' }, ctx, execute: async () => { log.push('start:r2'); await Bun.sleep(10); log.push('end:r2'); return { content: '2' } } })
      await Promise.all([r1, r2])
      expect(log.indexOf('end:r1')).toBeLessThan(log.indexOf('start:r2'))
    } finally {
      setToolSchedulerDisabled(false)
    }
    // 恢复后并行恢复
    const log2: string[] = []
    const a = runGuardedToolCall({ tool: read, args: { file_path: 'r.txt' }, ctx, execute: async () => { log2.push('start:a'); await Bun.sleep(40); log2.push('end:a'); return { content: 'a' } } })
    const b = runGuardedToolCall({ tool: read, args: { file_path: 'r.txt' }, ctx, execute: async () => { log2.push('start:b'); await Bun.sleep(10); log2.push('end:b'); return { content: 'b' } } })
    await Promise.all([a, b])
    expect(log2.indexOf('start:b')).toBeLessThan(log2.indexOf('end:a'))
  })
  test('错误与取消后调度器可复用：新调用正常完成，锁已释放', async () => {
    await expect(runGuardedToolCall({ tool: fakeTool('McpErr'), args: {}, ctx, execute: async () => { throw new Error('炸') } })).rejects.toThrow('炸')
    // 运行中的调用不被打断（既定语义）；取消作用于排队中的调用。
    const controller = new AbortController()
    const slow = runGuardedToolCall({ tool: fakeTool('McpSlow'), args: {}, ctx, execute: async () => { await Bun.sleep(120); return { content: 'slow' } } })
    const queued = runGuardedToolCall({ tool: fakeTool('McpQueued'), args: {}, ctx, signal: controller.signal, execute: async () => { return { content: 'queued' } } })
    setTimeout(() => controller.abort(), 20)
    await expect(queued).rejects.toThrow('已取消')
    await expect(slow).resolves.toEqual({ content: 'slow' })
    // 复用：同一调度器上的后续调用应立即执行（全局锁已释放）。
    const log: string[] = []
    await runGuardedToolCall({ tool: fakeTool('McpNext'), args: {}, ctx, execute: async () => { log.push('ran'); return { content: 'ok' } } })
    expect(log).toContain('ran')
    const metrics = toolExecutionScheduler.snapshotMetrics()
    expect(metrics.errored).toBeGreaterThanOrEqual(1)
    expect(metrics.cancelled).toBeGreaterThanOrEqual(1)
  })
})
