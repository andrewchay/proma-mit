import { describe, expect, test } from 'bun:test'
import { runCompactionWithFallback } from './compaction-fallback'

describe('M5-05 compaction fallback', () => {
  test('flag off goes straight to the legacy path without touching the tcc builder', async () => {
    let tccCalls = 0
    const result = await runCompactionWithFallback({
      enabled: false,
      buildView: () => {
        tccCalls += 1
        return 'tcc-view'
      },
      buildLegacy: () => 'legacy-view',
    })

    expect(tccCalls).toBe(0)
    expect(result).toEqual({ view: 'legacy-view', usedFallback: true, reason: 'tcc compaction disabled: using legacy path' })
  })

  test('tcc failure or empty result falls back with an auditable reason', async () => {
    const thrown = await runCompactionWithFallback({
      enabled: true,
      buildView: () => {
        throw new Error('projection exploded')
      },
      buildLegacy: () => 'legacy-view',
    })
    expect(thrown).toEqual({ view: 'legacy-view', usedFallback: true, reason: 'tcc view failed: projection exploded' })

    const empty = await runCompactionWithFallback({ enabled: true, buildView: () => null, buildLegacy: () => 'legacy-view' })
    expect(empty).toEqual({ view: 'legacy-view', usedFallback: true, reason: 'tcc view was empty: using legacy path' })
  })

  test('a successful tcc view skips the legacy path entirely', async () => {
    let legacyCalls = 0
    const result = await runCompactionWithFallback({
      enabled: true,
      buildView: () => 'tcc-view',
      buildLegacy: () => {
        legacyCalls += 1
        return 'legacy-view'
      },
    })

    expect(legacyCalls).toBe(0)
    expect(result).toEqual({ view: 'tcc-view', usedFallback: false })
  })
})
