/**
 * JSONLLocalAgentSpanSink 单元测试
 *
 * 覆盖：begin/end 配对落盘、错误 status、查询过滤、月度分文件、pending 不落盘。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { JSONLLocalAgentSpanSink, listAgentSpans } = await import('./agent-span-sink')
const { getAgentSpanMonthPath } = await import('./config-paths')

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'gravitas-span-sink-'))
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

const scope = { tenantId: 'local', userId: 'local' }

function makeSink() {
  return new JSONLLocalAgentSpanSink()
}

describe('JSONLLocalAgentSpanSink', () => {
  test('begin 后 pending 不落盘，end 后写入完整 span', async () => {
    const sink = makeSink()
    const spanId = 'span-tool-1'
    await sink.begin({
      ...scope,
      traceId: 'session-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      spanId,
      kind: 'tool',
      name: 'tool:Bash',
      startedAt: Date.now(),
      meta: { model: 'deepseek-v4' },
    })
    // begin 只入内存：此时文件不存在或无该 span 行
    const before = await listAgentSpans({ sessionId: 'session-1' })
    expect(before.filter((s) => s.spanId === spanId)).toHaveLength(0)

    await sink.end(spanId, { status: 'ok', meta: { inputKeys: ['command'], durationMs: 120 } })
    const after = await listAgentSpans({ sessionId: 'session-1' })
    const span = after.find((s) => s.spanId === spanId)
    expect(span).toBeDefined()
    expect(span!.status).toBe('ok')
    expect(span!.endedAt).toBeGreaterThanOrEqual(span!.startedAt)
    expect(span!.meta?.inputKeys).toEqual(['command'])
  })

  test('end 未知 spanId 静默忽略（不抛错）', async () => {
    const sink = makeSink()
    await sink.end('not-exists', { status: 'error', error: 'x' })
    expect(true).toBe(true)
  })

  test('错误 status 携带 error 字段落盘', async () => {
    const sink = makeSink()
    const spanId = 'span-err'
    await sink.begin({
      ...scope, traceId: 'session-2', sessionId: 'session-2', taskId: 'task-2',
      spanId, kind: 'tool', name: 'tool:Write', startedAt: Date.now(),
    })
    await sink.end(spanId, { status: 'error', error: '权限拒绝' })
    const spans = await listAgentSpans({ sessionId: 'session-2' })
    const span = spans.find((s) => s.spanId === spanId)
    expect(span?.status).toBe('error')
    expect(span?.error).toBe('权限拒绝')
  })

  test('attachCost 为空实现（不抛错、不写盘）', async () => {
    const sink = makeSink()
    await sink.attachCost(scope, 'task-x', 123)
    expect(true).toBe(true)
  })

  test('查询支持 sinceMs 与 limit，结果按 startedAt 升序', async () => {
    const sink = makeSink()
    const base = Date.now() - 10_000
    for (let i = 0; i < 5; i++) {
      const spanId = `span-q-${i}`
      await sink.begin({
        ...scope, traceId: 'session-q', sessionId: 'session-q', taskId: 'task-q',
        spanId, kind: 'tool', name: `tool:T${i}`, startedAt: base + i * 100,
      })
      await sink.end(spanId, { status: 'ok' })
    }
    // sinceMs 过滤：只留后 3 条
    const recent = await listAgentSpans({ sessionId: 'session-q', sinceMs: base + 200 })
    expect(recent).toHaveLength(3)
    // 升序
    const times = recent.map((s) => s.startedAt)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    // limit
    const limited = await listAgentSpans({ sessionId: 'session-q', limit: 2 })
    expect(limited).toHaveLength(2)
  })

  test('按月分文件：上月 span 也能被查询（跨月回看）', async () => {
    const path = getAgentSpanMonthPath(Date.now())
    expect(path).toContain('agent-spans')
    expect(path.endsWith('.jsonl')).toBe(true)
    // 手工造一条上月记录，验证 listAgentSpans 跨月回看
    const lastMonth = new Date()
    lastMonth.setMonth(lastMonth.getMonth() - 1)
    const oldPath = getAgentSpanMonthPath(lastMonth.getTime())
    mkdirSync(dirname(oldPath), { recursive: true })
    if (!existsSync(oldPath)) writeFileSync(oldPath, '', 'utf-8')
    const raw = JSON.stringify({
      ...scope, traceId: 'session-old', sessionId: 'session-old', taskId: 'task-old',
      spanId: 'span-old', kind: 'task', name: 'task:pi:old',
      startedAt: lastMonth.getTime(), endedAt: lastMonth.getTime() + 100, status: 'ok',
    })
    writeFileSync(oldPath, `${raw}\n`, 'utf-8')
    const spans = await listAgentSpans({ sessionId: 'session-old' })
    expect(spans.find((s) => s.spanId === 'span-old')).toBeDefined()
  })
})
