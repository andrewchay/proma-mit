/**
 * HR07–HR09：调度器锁事件矩阵（确定性、离线）。
 *
 * 用事件序列严格断言执行窗口关系，不用墙钟阈值断言性能或正确性：
 * - HR07：同键互斥写的两个调用，任一调用 execute_start..execute_end 区间内
 *   不得出现另一调用的 acquired/execute_start（锁域=本进程内经调度的调用）。
 * - HR07b：realpath 别名（符号链接）指向同一文件，同样互斥串行。
 * - HR08：同键共享读的两个调用，双方 execute 窗口必须重叠；结果 ID 各自完整。
 * - HR09：排队中被取消的调用零执行（无 acquired/execute_start）；
 *   执行中出错如实记 error 事件并释放锁，后续同键调用可继续。
 * - unknown 工具走全局排他键，跨批次（跨会话）串行。
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './types'
import { bindCoreToolEffects } from './tool-effects'
import { createReadToolDefinition, executeReadTool } from './tool-impls/read-tool'
import { createWriteToolDefinition, executeWriteTool } from './tool-impls/write-tool'
import { buildElectronMock } from '../testing/electron-mock'

const tempConfigDir = mkdtempSync(join(tmpdir(), 'proma-lock-events-config-'))
process.env.PROMA_TEST_CONFIG_DIR = tempConfigDir

mock.module('electron', () => buildElectronMock())
mock.module('../../attachment-service', () => ({
  isImageAttachment: () => false,
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => '',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock', mimeType: 'text/plain', size: 0 }),
  openFileDialog: async () => null,
}))

const { ToolScheduler } = await import('./tool-scheduler')
const { setToolSchedulerDisabled } = await import('./tool-scheduler-service')
type LockEvent = import('./tool-scheduler').LockEvent
type ScheduledCall = import('./tool-scheduler').ScheduledCall
type RuntimeToolDefinition = import('./types').RuntimeToolDefinition

beforeAll(() => setToolSchedulerDisabled(false))
afterAll(() => {
  setToolSchedulerDisabled(false)
  rmSync(tempConfigDir, { recursive: true, force: true })
})

const root = mkdtempSync(join(tmpdir(), 'hr-lock-events-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 工具必须绑定真实 execute 实例，effects 元数据才可信（planLockSpec 依据）。
 * 调度只执行 ScheduledCall.execute（探针），不会触碰 tool.execute。
 */
const readTool: RuntimeToolDefinition = bindCoreToolEffects({ ...createReadToolDefinition(), execute: executeReadTool })
const writeTool: RuntimeToolDefinition = bindCoreToolEffects({ ...createWriteToolDefinition(), execute: executeWriteTool })
const unknownTool: RuntimeToolDefinition = bindCoreToolEffects({ name: 'Mystery', description: 'unknown probe', parameters: { type: 'object', properties: {} }, execute: async () => ({ toolCallId: '', content: '' }) })

function probe(id: string, tool: RuntimeToolDefinition, input: unknown, run: () => Promise<string>, cwd?: string): { call: ScheduledCall; dir: string } {
  const dir = cwd ?? mkdtempSync(join(root, `${id}-`))
  const ctx: ToolContext = { cwd: dir, sessionId: `hr-${id}` }
  return { call: { id, tool, input, ctx, execute: run as ScheduledCall['execute'] }, dir }
}

function windowOf(events: readonly LockEvent[], callId: string): { start: number; end: number } {
  const start = events.find((e) => e.callId === callId && e.phase === 'execute_start')
  const end = events.find((e) => e.callId === callId && (e.phase === 'execute_end' || e.phase === 'error'))
  expect(start).toBeDefined()
  expect(end).toBeDefined()
  return { start: start!.seq, end: end!.seq }
}

/** 另一调用在本窗口内获得锁/开始执行（= 执行窗口重叠，互斥场景必须为 0）。 */
function otherActivityInside(events: readonly LockEvent[], callId: string, w: { start: number; end: number }): LockEvent[] {
  return events.filter((e) => e.callId !== callId && e.seq > w.start && e.seq < w.end
    && ['acquired', 'execute_start'].includes(e.phase))
}

describe('调度器锁事件矩阵（HR07–HR09）', () => {
  test('HR07：同键互斥写两个并发批次，execute 窗口严格不重叠', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const dir = mkdtempSync(join(root, 'hr07-'))
    // E02 契约：非规范绝对路径回退 unknown；试点输入使用相对路径 + cwd。
    const make = (id: string) => probe(id, writeTool, { file_path: 'shared.txt', content: id }, async () => id, dir).call
    const a = make('A')
    const b = make('B')
    const results = await Promise.all([scheduler.schedule([a]), scheduler.schedule([b])])
    expect(results.flat().every((r) => r.status === 'completed')).toBe(true)
    const events = scheduler.snapshotLockEvents()
    const wa = windowOf(events, 'A')
    const wb = windowOf(events, 'B')
    expect(otherActivityInside(events, 'A', wa)).toEqual([])
    expect(otherActivityInside(events, 'B', wb)).toEqual([])
    // 互斥强证据：一侧的 acquired 必然晚于另一侧的 execute_end/error。
    const aAcquired = events.find((e) => e.callId === 'A' && e.phase === 'acquired')!.seq
    const bAcquired = events.find((e) => e.callId === 'B' && e.phase === 'acquired')!.seq
    expect(wa.end < bAcquired || wb.end < aAcquired).toBe(true)
  })

  test('HR07b：realpath 符号链接别名解析为同一锁键，互斥串行', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const dir = mkdtempSync(join(root, 'hr07-alias-'))
    const real = join(dir, 'real.txt')
    writeFileSync(real, 'init')
    symlinkSync(real, join(dir, 'alias.txt'))
    const a = probe('A', writeTool, { file_path: 'real.txt', content: 'A' }, async () => 'A', dir)
    const b = probe('B', writeTool, { file_path: 'alias.txt', content: 'B' }, async () => 'B', dir)
    await Promise.all([scheduler.schedule([a.call]), scheduler.schedule([b.call])])
    const events = scheduler.snapshotLockEvents()
    expect(otherActivityInside(events, 'A', windowOf(events, 'A'))).toEqual([])
    expect(otherActivityInside(events, 'B', windowOf(events, 'B'))).toEqual([])
    // 两侧锁键一致（别名解析到同一真实路径）。
    const keysA = events.filter((e) => e.callId === 'A' && e.phase === 'acquired').map((e) => e.key)
    const keysB = events.filter((e) => e.callId === 'B' && e.phase === 'acquired').map((e) => e.key)
    expect(keysA.length).toBeGreaterThan(0)
    expect(keysA).toEqual(keysB)
    expect(keysA).toContain(realpathSync(real))
  })

  test('HR08：同键共享读并发批次 execute 窗口重叠，结果 ID 各自完整', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const dir = mkdtempSync(join(root, 'hr08-'))
    writeFileSync(join(dir, 'shared.txt'), 'data')
    let aInside = false
    const make = (id: string) => {
      const p = probe(id, readTool, { file_path: 'shared.txt' }, async () => {
      if (id === 'A') aInside = true
      // 让出到宏任务，给另一批次派发窗口；B 若在 A 结束前就启动，即为重叠直接证据。
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      if (id === 'B') expect(aInside).toBe(true)
      return id
      }, dir)
      return p.call
    }
    const results = await Promise.all([scheduler.schedule([make('A')]), scheduler.schedule([make('B')])])
    const ids = results.flat().map((r) => (r.status === 'completed' ? r.result : undefined))
    expect([...ids].sort()).toEqual(['A', 'B'])
    const events = scheduler.snapshotLockEvents()
    const wa = windowOf(events, 'A')
    const wb = windowOf(events, 'B')
    expect(wb.start < wa.end && wa.start < wb.end).toBe(true)
  })

  test('HR09a：排队中被取消的调用零执行（无 acquired/execute_start）', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 1 })
    const dir = mkdtempSync(join(root, 'hr09-cancel-'))
    const blocker = probe('BLOCKER', writeTool, { file_path: 'same.txt', content: '1' }, async () => 'BLOCKER', dir)
    const victim = probe('VICTIM', writeTool, { file_path: 'same.txt', content: '2' }, async () => 'VICTIM', dir)
    const controller = new AbortController()
    const first = scheduler.schedule([blocker.call])
    // BLOCKER 进入执行后 VICTIM 只能排队（并发上限1 + 同键互斥）。
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const second = scheduler.schedule([victim.call], controller.signal)
    controller.abort()
    const [r1, r2] = await Promise.all([first, second])
    expect(r1[0]!.status).toBe('completed')
    expect(r2[0]!.status).toBe('cancelled')
    const events = scheduler.snapshotLockEvents()
    expect(events.some((e) => e.callId === 'VICTIM' && (e.phase === 'acquired' || e.phase === 'execute_start'))).toBe(false)
  })

  test('HR09b：执行中出错如实记 error 事件、释放锁，后续同键调用继续', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const dir = mkdtempSync(join(root, 'hr09-error-'))
    const failing = probe('FAILING', writeTool, { file_path: 'same.txt', content: 'x' }, async () => { throw new Error('probe-failure') }, dir)
    const followup = probe('FOLLOWUP', writeTool, { file_path: 'same.txt', content: 'y' }, async () => 'FOLLOWUP', dir)
    const [r1] = await scheduler.schedule([failing.call])
    expect(r1!.status).toBe('error')
    const [r2] = await scheduler.schedule([followup.call])
    expect(r2!.status).toBe('completed')
    const events = scheduler.snapshotLockEvents()
    const failingEvents = events.filter((e) => e.callId === 'FAILING')
    expect(failingEvents.some((e) => e.phase === 'error')).toBe(true)
    expect(failingEvents.some((e) => e.phase === 'released')).toBe(true)
    expect(failingEvents.find((e) => e.phase === 'error')!.seq
      < events.find((e) => e.callId === 'FOLLOWUP' && e.phase === 'acquired')!.seq).toBe(true)
  })

  test('unknown 工具走全局排他键，跨批次串行', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 4 })
    const a = probe('A', unknownTool, {}, async () => 'A')
    const b = probe('B', unknownTool, {}, async () => 'B')
    await Promise.all([scheduler.schedule([a.call]), scheduler.schedule([b.call])])
    const events = scheduler.snapshotLockEvents()
    expect(events.every((e) => e.key === 'global:unknown')).toBe(true)
    expect(otherActivityInside(events, 'A', windowOf(events, 'A'))).toEqual([])
    expect(otherActivityInside(events, 'B', windowOf(events, 'B'))).toEqual([])
  })
})
