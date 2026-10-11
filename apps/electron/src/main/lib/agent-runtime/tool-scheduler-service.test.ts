import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'

const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const dir = mkdtempSync(join(tmpdir(), 'gravitas-scheduler-svc-'))
process.env.PROMA_TEST_CONFIG_DIR = dir
mock.module('electron', () => buildElectronMock())
const { bindCoreToolEffects } = await import('./tool-effects')
const { createWriteToolDefinition, executeWriteTool } = await import('./tool-impls/write-tool')
const { createReadToolDefinition, executeReadTool } = await import('./tool-impls/read-tool')
const { runGuardedToolCall, toolExecutionScheduler } = await import('./tool-scheduler-service')
const { ToolScheduler } = await import('./tool-scheduler')

beforeAll(() => { mkdirSync(join(dir, 'work')) })
afterAll(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(dir, { recursive: true, force: true })
})
const cwd = join(dir, 'work')
const write = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const read = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const ctx = { cwd, sessionId: 'svc-fixture' }
const fakeTool = (name: string): ReturnType<typeof bindCoreToolEffects> => bindCoreToolEffects({ name, description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })

describe('生产调度接线（E05）', () => {
  test('同文件跨并发调用串行（锁域内），独立文件读取并行', async () => {
    const log: string[] = []
    const slowWrite = (id: string, ms: number) => runGuardedToolCall({
      tool: write, args: { file_path: `${id}.txt`, content: id }, ctx,
      execute: async () => { log.push(`start:${id}`); await Bun.sleep(ms); log.push(`end:${id}`); return { content: id } },
    })
    await Promise.all([slowWrite('g1', 50), slowWrite('g2', 10)])
    expect(log.indexOf('end:g1')).toBeLessThan(log.indexOf('start:g2'))
    const readLog: string[] = []
    const r = (id: string, file: string, ms: number) => runGuardedToolCall({
      tool: read, args: { file_path: file }, ctx,
      execute: async () => { readLog.push(`start:${id}`); await Bun.sleep(ms); readLog.push(`end:${id}`); return { content: id } },
    })
    writeFileSync(join(cwd, 'p1.txt'), '1'); writeFileSync(join(cwd, 'p2.txt'), '2')
    await Promise.all([r('r1', 'p1.txt', 40), r('r2', 'p2.txt', 40)])
    expect(readLog.indexOf('start:r2')).toBeLessThan(readLog.indexOf('end:r1'))
  })
  test('交互式工具旁路调度：全局写阻塞时仍立即执行', async () => {
    const log: string[] = []
    const blocker = runGuardedToolCall({
      tool: write, args: { file_path: 'block.txt', content: 'x' }, ctx,
      execute: async () => { await Bun.sleep(60); return { content: 'x' } },
    })
    const ask = fakeTool('AskUserQuestion')
    const askResult = await runGuardedToolCall({
      tool: ask, args: {}, ctx, execute: async () => { log.push('ask-ran'); return { content: 'ok' } },
    })
    await blocker
    expect(askResult.content).toBe('ok')
    expect(log).toContain('ask-ran')
  })
  test('unknown 工具（fakeTool）在共享调度器上全局串行', async () => {
    const log: string[] = []
    const tool = fakeTool('McpFake')
    const mk = (id: string, ms: number) => runGuardedToolCall({
      tool, args: {}, ctx, execute: async () => { log.push(`start:${id}`); await Bun.sleep(ms); log.push(`end:${id}`); return { content: id } },
    })
    await Promise.all([mk('u1', 50), mk('u2', 10)])
    expect(log.indexOf('end:u1')).toBeLessThan(log.indexOf('start:u2'))
  })
  test('执行错误原样抛出；指标计数正确', async () => {
    const before = toolExecutionScheduler.snapshotMetrics()
    const tool = fakeTool('McpBoom')
    await expect(runGuardedToolCall({ tool, args: {}, ctx, execute: async () => { throw new Error('provider 故障') } })).rejects.toThrow('provider 故障')
    await runGuardedToolCall({ tool: fakeTool('McpOk'), args: {}, ctx, execute: async () => ({ content: 'ok' }) })
    const after = toolExecutionScheduler.snapshotMetrics()
    expect(after.errored).toBe(before.errored + 1)
    expect(after.completed).toBeGreaterThanOrEqual(before.completed + 1)
    expect(after.dispatched).toBeGreaterThanOrEqual(before.dispatched + 2)
    expect(after.totalWaitMs).toBeGreaterThanOrEqual(0)
  })
  test('并发上限在共享调度器上生效', async () => {
    let active = 0
    let maxActive = 0
    const tool = fakeTool('McpConc')
    const mk = () => runGuardedToolCall({
      tool, args: {}, ctx, execute: async () => { active += 1; maxActive = Math.max(maxActive, active); await Bun.sleep(20); active -= 1; return { content: 'x' } },
    })
    await Promise.all([mk(), mk(), mk(), mk(), mk(), mk()])
    expect(maxActive).toBeLessThanOrEqual(4)
  })
  test('调度器指标快照为独立副本', () => {
    const scheduler = new ToolScheduler()
    const snap = scheduler.snapshotMetrics()
    expect(scheduler.snapshotMetrics()).not.toBe(snap)
  })
})
