import { expect, test } from 'bun:test'
import { loadTccSpawnFixture } from './tcc-spawn-fixture'
import { evaluateTccSpawnEligibility, checkTccEvalPreflight, runTccSpawnExperiment } from './tcc-spawn-experiment'
const fixture = loadTccSpawnFixture(await Bun.file(new URL('./fixtures/m3-spawn-representative.json', import.meta.url)).json())
test('passes preflight so paid evaluation is not spent on a broken protocol contract', () => {
  const result = checkTccEvalPreflight(fixture.cases)
  expect(result.reasons).toEqual([])
  expect(result.ready).toBe(true)
})

test('blocks paid evaluation unless representative projections save at least 20% tokens', () => {
  const result = evaluateTccSpawnEligibility(fixture.cases)
  expect(result.eligible).toBe(true)
  expect(result.savingsRate).toBeGreaterThanOrEqual(0.2)
})

test('runs variants through the spawn projection boundary with typed read-only input', async () => {
  const records = await runTccSpawnExperiment(fixture.cases[0]!, async (input, record) => {
    expect(input.context?.readOnly).toBe(true); expect(input.context?.resultProtocol).toBe('typed-v1'); expect(record.readOnly).toBe(true); return 'ok'
  })
  expect(records.map((record) => record.variant)).toEqual(['full_context', 'brief', 'tcc_projection'])
  const tcc = records[2]!; expect(tcc.projectionId).toBeDefined(); expect(tcc.selectedItemIds).not.toContain('case-001-private')
})
