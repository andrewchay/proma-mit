/**
 * span-timeline 瀑布图布局纯函数测试。
 */

import { describe, test, expect } from 'bun:test'
import { buildSpanTimeline, groupSpansByRun } from './span-timeline'
import type { RuntimeSpan } from '@gravitas/shared'

function makeSpan(over: Partial<RuntimeSpan>): RuntimeSpan {
  return {
    tenantId: 'local', userId: 'local',
    traceId: 's1', sessionId: 's1', taskId: 'run-1',
    spanId: 'sp', kind: 'tool', name: 'tool:Bash',
    startedAt: 0, endedAt: 100, status: 'ok',
    ...over,
  } as RuntimeSpan
}

describe('groupSpansByRun', () => {
  test('按 taskId 分组，run 按时间倒序，组内升序', () => {
    const spans = [
      makeSpan({ spanId: 'a', taskId: 'run-1', startedAt: 100, kind: 'task', name: 'task:pi:m' }),
      makeSpan({ spanId: 'b', taskId: 'run-2', startedAt: 500, kind: 'task', name: 'task:pi:m' }),
      makeSpan({ spanId: 'c', taskId: 'run-1', startedAt: 150 }),
      makeSpan({ spanId: 'd', taskId: 'run-2', startedAt: 550 }),
    ]
    const runs = groupSpansByRun(spans)
    expect(runs.map((r) => r.taskId)).toEqual(['run-2', 'run-1'])
    expect(runs[0]!.spans.map((s) => s.spanId)).toEqual(['b', 'd'])
  })
})

describe('buildSpanTimeline', () => {
  test('计算 leftPct/widthPct，task 行 depth 0，tool 行 depth 1', () => {
    const run = [
      makeSpan({ spanId: 'task', kind: 'task', name: 'task:pi:m', startedAt: 0, endedAt: 1000 }),
      makeSpan({ spanId: 't1', startedAt: 100, endedAt: 400, parentSpanId: 'task' }),
      makeSpan({ spanId: 't2', startedAt: 500, endedAt: 900, parentSpanId: 'task' }),
    ]
    const rows = buildSpanTimeline(run)
    expect(rows).toHaveLength(3)
    const t1 = rows.find((r) => r.span.spanId === 't1')!
    expect(t1.leftPct).toBe(10)
    expect(t1.widthPct).toBe(30)
    expect(t1.depth).toBe(1)
    const task = rows.find((r) => r.span.spanId === 'task')!
    expect(task.depth).toBe(0)
    expect(task.widthPct).toBe(100)
  })

  test('零时长 run 不产生 NaN（最小宽度兜底）', () => {
    const run = [makeSpan({ spanId: 'z', kind: 'task', startedAt: 50, endedAt: 50 })]
    const rows = buildSpanTimeline(run)
    expect(Number.isFinite(rows[0]!.widthPct)).toBe(true)
  })

  test('durationMs 正确计算', () => {
    const run = [makeSpan({ spanId: 'd', startedAt: 0, endedAt: 1500 })]
    const rows = buildSpanTimeline(run)
    expect(rows[0]!.durationMs).toBe(1500)
  })
})
