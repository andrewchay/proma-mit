import { expect, test } from 'bun:test'
import { detectBenchmarkDrift, nextBenchmarkVersion, readBenchmarkVersion } from './benchmark-versioning'
import type { BenchmarkConfig } from './types'

function config(overrides: Partial<BenchmarkConfig> = {}): BenchmarkConfig {
  return {
    id: 'bench', title: 't', description: '', targetAgentId: 'agent', runtime: { provider: 'p', modelId: 'm' },
    runsPerCase: 1, targetScore: 80, cases: ['a', 'b'], heldOutCases: ['c'], createdAt: '', updatedAt: '', ...overrides,
  }
}

test('case 或目标变化但版本未递增时报告漂移', () => {
  const previous = readBenchmarkVersion(config({ version: 2, rubricVersion: 1 }))
  const changedCases = readBenchmarkVersion(config({ version: 2, rubricVersion: 1, cases: ['a', 'b', 'd'] }))
  expect(detectBenchmarkDrift(previous, changedCases).drifted).toBe(true)
  expect(detectBenchmarkDrift(previous, changedCases).reasons.some((r) => r.includes('版本号未递增'))).toBe(true)

  const changedTarget = readBenchmarkVersion(config({ version: 2, rubricVersion: 1, targetAgentId: 'other' }))
  expect(detectBenchmarkDrift(previous, changedTarget).reasons.some((r) => r.includes('被测目标'))).toBe(true)
  expect(detectBenchmarkDrift(previous, changedTarget).drifted).toBe(true)
})

test('版本递增后不算漂移，版本回退被拒绝', () => {
  const previous = readBenchmarkVersion(config({ version: 2, rubricVersion: 1 }))
  const bumped = readBenchmarkVersion(config({ version: 3, rubricVersion: 2, cases: ['a', 'b', 'd'] }))
  expect(detectBenchmarkDrift(previous, bumped).drifted).toBe(false)
  const rollback = readBenchmarkVersion(config({ version: 1, rubricVersion: 1 }))
  expect(detectBenchmarkDrift(previous, rollback).reasons.some((r) => r.includes('不能回退'))).toBe(true)
})

test('内容变化时下一版本必须递增', () => {
  const previous = readBenchmarkVersion(config({ version: 4 }))
  expect(nextBenchmarkVersion(previous, true)).toBe(5)
  expect(nextBenchmarkVersion(previous, false)).toBe(4)
  expect(nextBenchmarkVersion(null, true)).toBe(1)
})
