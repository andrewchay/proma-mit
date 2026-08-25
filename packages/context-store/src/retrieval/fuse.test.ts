import { describe, it, expect } from 'bun:test'
import { fuseRrf, buildRecallDebug } from './fuse.ts'

describe('fuseRrf', () => {
  it('fuses two lists', () => {
    const lists = [
      { source: 'fts', ids: ['a', 'b', 'c'] },
      { source: 'graph', ids: ['b', 'a', 'd'] },
    ]
    const fused = fuseRrf(lists)

    // a 和 b 都被两路命中：
    // a: fts#1 + graph#2 = 1/61 + 1/62 ≈ 0.03252
    // b: fts#2 + graph#1 = 1/62 + 1/61 ≈ 0.03252
    // 分数几乎相同，但 a 的 fts#1 排名更靠前
    // 实际上由于浮点精度，a 可能略高于 b
    expect(fused[0]?.hitBy.length).toBe(2)
    expect(fused[1]?.hitBy.length).toBe(2)
    // a 和 b 都在前两位（顺序取决于浮点精度）
    const topIds = fused.slice(0, 2).map((h) => h.id).sort()
    expect(topIds).toEqual(['a', 'b'])
  })

  it('prefers multi-source hits', () => {
    const lists = [
      { source: 'fts', ids: ['x', 'y'] },
      { source: 'graph', ids: ['y'] },
    ]
    const fused = fuseRrf(lists)

    // y 被两路命中，x 只被一路命中
    expect(fused[0]?.id).toBe('y')
    expect(fused[1]?.id).toBe('x')
  })

  it('respects topK limit', () => {
    const lists = [{ source: 'fts', ids: ['a', 'b', 'c', 'd', 'e'] }]
    const fused = fuseRrf(lists, { topK: 3 })
    expect(fused).toHaveLength(3)
  })

  it('handles empty lists', () => {
    expect(fuseRrf([])).toEqual([])
  })

  it('is deterministic with ties', () => {
    const lists = [
      { source: 'fts', ids: ['a'] },
      { source: 'graph', ids: ['b'] },
    ]
    const fused = fuseRrf(lists)
    // a 和 b 分数相同（各被一路命中，rank=1），hitBy 长度相同
    // 按 id 排序：a < b
    expect(fused[0]?.id).toBe('a')
    expect(fused[1]?.id).toBe('b')
  })
})

describe('buildRecallDebug', () => {
  it('builds debug info', () => {
    const lists = [
      { source: 'fts', ids: ['a', 'b'], latencyMs: 12 },
      { source: 'graph', ids: ['b', 'c'], latencyMs: 8 },
    ]
    const fused = fuseRrf(lists)
    const debug = buildRecallDebug(lists, fused)

    expect(debug.perSource).toHaveLength(2)
    expect(debug.perSource[0]?.source).toBe('fts')
    expect(debug.perSource[0]?.count).toBe(2)
    expect(debug.perSource[0]?.latencyMs).toBe(12)
    expect(debug.fusedCount).toBe(fused.length)
  })
})
