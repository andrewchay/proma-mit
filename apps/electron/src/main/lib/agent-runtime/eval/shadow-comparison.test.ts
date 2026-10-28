import { describe, expect, test } from 'bun:test'
import { compareShadowRuns, describeShadowComparison, type ShadowRunResult } from './shadow-comparison'

const run = (label: string, scores: Array<[string, number | null]>, overrides: Partial<ShadowRunResult> = {}): ShadowRunResult => ({
  label,
  benchmarkVersion: 3,
  rubricVersion: 2,
  cases: scores.map(([caseId, score]) => ({ caseId, score })),
  ...overrides,
})

describe('compareShadowRuns（可比性）', () => {
  test('Given 版本与 case 一致且分数齐全 When 比较 Then 给出差值结论', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.5], ['b', 0.6], ['c', 0.7]]),
      run('candidate', [['a', 0.6], ['b', 0.6], ['c', 0.9]]),
    )
    expect(result.comparable).toBe(true)
    expect(result.reasons).toEqual([])
    expect(result.cases.map((item) => item.caseId)).toEqual(['a', 'b', 'c'])
    expect(result.meanBaseline).toBeCloseTo(0.6, 5)
    expect(result.meanCandidate).toBeCloseTo(0.7, 5)
    expect(result.meanDelta).toBeCloseTo(0.1, 5)
    expect(result.improved).toBe(2)
    expect(result.unchanged).toBe(1)
    expect(result.regressed).toBe(0)
    expect(result.verdict).toBe('candidate_better')
  })

  test('Given 候选明显下降 When 比较 Then 判为 candidate_worse', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.8], ['b', 0.9]]),
      run('candidate', [['a', 0.5], ['b', 0.6]]),
    )
    expect(result.verdict).toBe('candidate_worse')
    expect(result.regressed).toBe(2)
    expect(result.meanDelta).toBeLessThan(0)
  })

  test('Given 差值小于阈值 When 比较 Then 判为无差异而不是更好', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.80], ['b', 0.80]]),
      run('candidate', [['a', 0.81], ['b', 0.81]]),
    )
    expect(result.comparable).toBe(true)
    expect(result.verdict).toBe('no_difference')
  })

  test('Given 阈值可配置 When 差值超过阈值 Then 按配置判定', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.8]]),
      run('candidate', [['a', 0.83]]),
      { deltaThreshold: 0.01 },
    )
    expect(result.verdict).toBe('candidate_better')
  })

  test('Given 基准版本不同 When 比较 Then 不可比且不下结论', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.8]]),
      run('candidate', [['a', 0.9]], { benchmarkVersion: 4 }),
    )
    expect(result.comparable).toBe(false)
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons.join()).toContain('基准版本不同')
    expect(result.meanDelta).toBeNull()
  })

  test('Given rubric 版本不同 When 比较 Then 不可比', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.8]]),
      run('candidate', [['a', 0.9]], { rubricVersion: 3 }),
    )
    expect(result.comparable).toBe(false)
    expect(result.reasons.join()).toContain('rubric 版本不同')
  })

  test('Given case 集合不同 When 比较 Then 不可比且说明缺哪些', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.8], ['b', 0.7]]),
      run('candidate', [['a', 0.9], ['c', 0.7]]),
    )
    expect(result.comparable).toBe(false)
    expect(result.reasons.join()).toContain('候选缺少 case：b')
    expect(result.reasons.join()).toContain('候选多出 case：c')
  })

  test('Given case 重复 When 比较 Then 不可比', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.8], ['a', 0.9]]),
      run('candidate', [['a', 0.9]]),
    )
    expect(result.comparable).toBe(false)
    expect(result.reasons.join()).toContain('case 重复')
  })

  test('Given 一侧缺分 When 比较 Then 不可比且不把缺分当 0', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.8], ['b', 0.6]]),
      run('candidate', [['a', 0.9], ['b', null]]),
    )
    expect(result.comparable).toBe(false)
    expect(result.verdict).toBe('inconclusive')
    expect(result.reasons.join()).toContain('缺少有效分数：b')
    expect(result.meanCandidate).toBeNull()
    // 有分数的 case 仍保留在明细里，供人工查看，但不参与结论。
    expect(result.cases.map((item) => item.caseId)).toEqual(['a'])
  })

  test('Given 分数越界或非有限 When 比较 Then 不可比', () => {
    for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = compareShadowRuns(
        run('baseline', [['a', 0.8]]),
        run('candidate', [['a', bad]]),
      )
      expect(result.comparable).toBe(false)
      expect(result.reasons.join()).toContain('缺少有效分数：a')
    }
  })
})

describe('describeShadowComparison（结论表述）', () => {
  test('Given 可比且候选更好 When 描述 Then 含趋势与差值', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.5], ['b', 0.5]]),
      run('candidate', [['a', 0.8], ['b', 0.7]]),
    )
    const text = describeShadowComparison(result)
    expect(text).toContain('候选更好')
    expect(text).toContain('+0.250')
    expect(text).toContain('改善 2')
  })

  test('Given 不可比 When 描述 Then 明确不下结论并给出原因', () => {
    const result = compareShadowRuns(
      run('baseline', [['a', 0.5]]),
      run('candidate', [['a', null]]),
    )
    const text = describeShadowComparison(result)
    expect(text).toContain('不可比')
    expect(text).toContain('不下结论')
    expect(text).toContain('缺少有效分数')
  })
})

describe('compareScoreboardEvaluations（scoreboard 适配）', () => {
  const benchmark = {
    id: 'shadow-fixture',
    title: '影子对比夹具',
    description: '仅用于测试',
    targetAgentId: 'code-reviewer' as const,
    runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    runsPerCase: 1,
    targetScore: 80,
    cases: ['c1', 'c2'],
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
    version: 2,
    rubricVersion: 3,
  } as unknown as import('./types').BenchmarkConfig

  const evaluation = (agentVersion: number, scores: Array<[string, number]>) => ({
    time: '2026-10-29T00:00:00Z',
    agentVersion,
    score: 0,
    runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    cases: scores.map(([caseId, score]) => ({ caseId, score, runs: [] })),
  }) as unknown as import('./types').BenchmarkEvaluation

  test('Given 两条同定义评测 When 比较 Then 百分制换算为 0..1 并给出结论', async () => {
    const { compareScoreboardEvaluations } = await import('./shadow-comparison')
    const result = compareScoreboardEvaluations({
      benchmark,
      baseline: evaluation(1, [['c1', 60], ['c2', 70]]),
      candidate: evaluation(2, [['c1', 80], ['c2', 90]]),
    })
    expect(result.comparable).toBe(true)
    expect(result.meanBaseline).toBeCloseTo(0.65, 5)
    expect(result.meanCandidate).toBeCloseTo(0.85, 5)
    expect(result.verdict).toBe('candidate_better')
  })

  test('Given 候选缺一个 case When 比较 Then 不可比并指出缺哪个', async () => {
    const { compareScoreboardEvaluations } = await import('./shadow-comparison')
    const result = compareScoreboardEvaluations({
      benchmark,
      baseline: evaluation(1, [['c1', 60], ['c2', 70]]),
      candidate: evaluation(2, [['c1', 80]]),
    })
    expect(result.comparable).toBe(false)
    expect(result.reasons.join()).toContain('候选缺少 case：c2')
  })

  test('Given 同一个基准定义 When 比较 Then 两侧版本一致（影子前提）', async () => {
    const { shadowRunFromEvaluation } = await import('./shadow-comparison')
    const left = shadowRunFromEvaluation(evaluation(1, [['c1', 60]]), { label: 'baseline', benchmarkVersion: 2, rubricVersion: 3 })
    const right = shadowRunFromEvaluation(evaluation(9, [['c1', 60]]), { label: 'candidate', benchmarkVersion: 2, rubricVersion: 3 })
    // 被测对象版本不同不构成不可比；只有基准定义变化才是。
    expect(compareShadowRuns(left, right).comparable).toBe(true)
    expect(left.cases[0]?.score).toBeCloseTo(0.6, 5)
  })
})
