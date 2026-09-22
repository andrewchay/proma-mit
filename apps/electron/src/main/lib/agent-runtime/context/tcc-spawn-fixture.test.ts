import { describe, expect, test } from 'bun:test'
import { compileContextProjection } from './context-projector'
import { loadTccSpawnFixture } from './tcc-spawn-fixture'

const rawFixture = await Bun.file(new URL('./fixtures/m3-spawn-representative.json', import.meta.url)).json()

describe('representative TCC spawn fixture', () => {
  test('contains long noisy parent contexts with required and private facts', () => {
    const fixture = loadTccSpawnFixture(rawFixture)
    expect(fixture.cases).toHaveLength(10)
    for (const testCase of fixture.cases) {
      expect(testCase.items).toHaveLength(23)
      expect(testCase.requiredItemIds).toHaveLength(2)
      const projection = compileContextProjection({ request: testCase.projectionRequest, items: testCase.items, sourceRevision: testCase.id })
      const projected = new Set(projection.items.map((item) => item.itemId))
      expect(testCase.forbiddenItemIds.every((id) => !projected.has(id))).toBe(true)
      expect(projection.tokenEstimate * 4).toBeLessThanOrEqual(Math.ceil(testCase.items.reduce((total, item) => total + item.content.length / 4, 0)))
    }
  })

  test('fails closed when fixture references missing required evidence', () => {
    const broken = structuredClone(rawFixture) as { cases: Array<{ requiredItemIds: string[] }> }
    broken.cases[0]!.requiredItemIds = ['missing']
    expect(() => loadTccSpawnFixture(broken)).toThrow('references missing item missing')
  })
})
