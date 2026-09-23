import { describe, expect, test } from 'bun:test'
import { evaluateTccExperimentGate, summarizeTccExperiment, type TccExperimentRun, type TccExperimentScoreboard } from './tcc-experiment'

const cases = Array.from({ length: 10 }, (_, index) => ({
  id: `CASE-${String(index + 1).padStart(3, '0')}`,
  task: `验证上下文 case ${index + 1}`,
  requiredItemIds: [`fact-${index + 1}`],
  forbiddenItemIds: [`secret-${index + 1}`],
}))

function run(caseId: string, variant: TccExperimentRun['variant'], index: number, overrides: Partial<TccExperimentRun> = {}): TccExperimentRun {
  return {
    caseId,
    variant,
    run: index,
    provider: 'test-provider',
    modelId: 'test-model',
    implementationVersion: 'tcc-v1',
    status: 'ok',
    score: 90,
    inputTokens: variant === 'tcc_projection' ? 60 : variant === 'brief' ? 80 : 100,
    outputTokens: 20,
    cacheStatus: 'unknown',
    durationMs: variant === 'tcc_projection' ? 50 : 100,
    retryCount: variant === 'tcc_projection' ? 0 : 1,
    selectedItemIds: [`fact-${Number(caseId.slice(-3))}`],
    verifiedClaims: variant === 'tcc_projection' ? 9 : 0,
    totalClaims: variant === 'tcc_projection' ? 10 : 0,
    ...overrides,
  }
}

function completeScoreboard(): TccExperimentScoreboard {
  return {
    version: 1,
    benchmarkId: 'typed-context-compiler',
    cases,
    runs: cases.flatMap((testCase) => {
      const variants: TccExperimentRun['variant'][] = ['full_context', 'brief', 'tcc_projection']
      return variants.flatMap((variant) => [1, 2, 3].map((index) => run(testCase.id, variant, index)))
    }),
  }
}

describe('Typed Context Compiler M3 experiment', () => {
  test('given complete three-way runs when evaluating the gate then TCC can pass only with evidence, quality, and efficiency', () => {
    const result = evaluateTccExperimentGate(completeScoreboard())

    expect(result.passed).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.summaries.find((summary) => summary.variant === 'tcc_projection')).toMatchObject({
      evidenceCoverage: 0.9,
      falseOmissionRate: 0,
      falseInclusionRate: 0,
      unknownCacheRuns: 30,
    })
  })

  test('given missing runs or skipped work when evaluating the gate then it fails closed rather than treating it as a pass', () => {
    const scoreboard = completeScoreboard()
    scoreboard.runs = scoreboard.runs.filter((item) => !(item.caseId === 'CASE-001' && item.variant === 'tcc_projection' && item.run === 3))
    scoreboard.runs[0] = { ...scoreboard.runs[0]!, status: 'skipped' }

    const result = evaluateTccExperimentGate(scoreboard)

    expect(result.passed).toBe(false)
    expect(result.reasons).toContain('CASE-001/tcc_projection has fewer than 3 runs')
    expect(result.reasons).toContain('CASE-001/full_context includes skipped runs')
  })

  test('given a TCC run that omits required evidence when evaluating the gate then false omission blocks adoption', () => {
    const scoreboard = completeScoreboard()
    const indexes = scoreboard.runs
      .map((item, index) => item.caseId === 'CASE-001' && item.variant === 'tcc_projection' ? index : -1)
      .filter((index) => index >= 0)
    for (const index of indexes.slice(0, 2)) scoreboard.runs[index] = { ...scoreboard.runs[index]!, selectedItemIds: [] }

    const result = evaluateTccExperimentGate(scoreboard)

    expect(result.passed).toBe(false)
    expect(result.reasons).toContain('TCC false omission rate exceeds 5%')
  })

  test('given unknown cache status when summarizing then input tokens remain fully counted', () => {
    const summaries = summarizeTccExperiment(completeScoreboard())
    const tcc = summaries.find((summary) => summary.variant === 'tcc_projection')!

    expect(tcc.inputTokens).toBe(1_800)
    expect(tcc.unknownCacheRuns).toBe(30)
  })
})
