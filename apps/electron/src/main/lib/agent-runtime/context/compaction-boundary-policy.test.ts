import { describe, expect, test } from 'bun:test'
import { evaluateCompactionBoundary } from './compaction-boundary-policy'

describe('M5-04 compaction boundary policy', () => {
  test('ok outcome with content writes a boundary and pi/automatic audit', () => {
    const decision = evaluateCompactionBoundary({
      status: 'ok',
      summary: '已压缩历史',
      retainedItemIds: ['fact-1'],
      tokenEstimate: 120,
    })
    expect(decision).toEqual({ writeBoundary: true, auditKind: 'pi/automatic', reason: 'compaction completed with retained content' })
  })

  test('aborted, errored and empty outcomes never write a success boundary or audit', () => {
    for (const status of ['aborted', 'error', 'empty'] as const) {
      const decision = evaluateCompactionBoundary({ status, summary: '看起来有内容', retainedItemIds: ['fact-1'] })
      expect(decision.writeBoundary).toBe(false)
      expect(decision.auditKind).toBeNull()
    }
    expect(evaluateCompactionBoundary({ status: 'aborted' }).reason).toContain('aborted')
    expect(evaluateCompactionBoundary({ status: 'error' }).reason).toContain('errored')
    expect(evaluateCompactionBoundary({ status: 'empty' }).reason).toContain('no result')
  })

  test('ok outcome without summary or retained items is treated as empty, not success', () => {
    const noSummary = evaluateCompactionBoundary({ status: 'ok', retainedItemIds: ['fact-1'] })
    const noItems = evaluateCompactionBoundary({ status: 'ok', summary: '只有摘要' })
    expect(noSummary.writeBoundary).toBe(false)
    expect(noItems.writeBoundary).toBe(false)
    expect(noSummary.reason).toContain('missing summary or retained items')
  })
})
