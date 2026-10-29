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

describe('compareShadowRuns（成本与延迟）', () => {
  const withCost = (label: string, score: number, costUsd?: number | null, durationMs?: number | null): ShadowRunResult => ({
    label,
    benchmarkVersion: 1,
    rubricVersion: 1,
    cases: [{ caseId: 'a', score }],
    costUsd,
    durationMs,
  })

  test('Given 未配置门禁 When 比较 Then 只报告变化比例且 gate=pass', () => {
    const result = compareShadowRuns(withCost('b', 0.6, 1, 1000), withCost('c', 0.8, 1.5, 900))
    expect(result.resources.gate).toBe('pass')
    expect(result.resources.costIncreaseRatio).toBeCloseTo(0.5, 5)
    expect(result.resources.costDeltaUsd).toBeCloseTo(0.5, 5)
    expect(result.resources.durationIncreaseRatio).toBeCloseTo(-0.1, 5)
    expect(result.resources.reasons).toEqual([])
  })

  test('Given 成本增幅超阈值 When 比较 Then gate=cost_exceeded 并说明比例', () => {
    const result = compareShadowRuns(withCost('b', 0.6, 1, 1000), withCost('c', 0.9, 1.4, 1000), { maxCostIncreaseRatio: 0.2 })
    expect(result.resources.gate).toBe('cost_exceeded')
    expect(result.resources.reasons.join()).toContain('成本增幅 40.0% 超过允许的 20.0%')
    // 分数结论仍独立给出：门禁不篡改分数语义。
    expect(result.verdict).toBe('candidate_better')
  })

  test('Given 耗时增幅超阈值 When 比较 Then gate=latency_exceeded', () => {
    const result = compareShadowRuns(withCost('b', 0.6, 1, 1000), withCost('c', 0.9, 1, 3000), { maxLatencyIncreaseRatio: 0.5 })
    expect(result.resources.gate).toBe('latency_exceeded')
    expect(result.resources.reasons.join()).toContain('耗时增幅 200.0%')
  })

  test('Given 配置门禁但缺成本数据 When 比较 Then gate=unverified 而不是通过', () => {
    const result = compareShadowRuns(withCost('b', 0.6, null, 1000), withCost('c', 0.9, 1.4, 1000), { maxCostIncreaseRatio: 0.2 })
    expect(result.resources.gate).toBe('unverified')
    expect(result.resources.reasons.join()).toContain('成本数据缺失，门禁未核验')
    expect(result.resources.costIncreaseRatio).toBeNull()
  })

  test('Given 基线成本为 0 When 比较 Then 比例记 null 且门禁不可核验', () => {
    const result = compareShadowRuns(withCost('b', 0.6, 0, 1000), withCost('c', 0.9, 2, 1000), { maxCostIncreaseRatio: 0.2 })
    expect(result.resources.costIncreaseRatio).toBeNull()
    expect(result.resources.costDeltaUsd).toBeCloseTo(2, 5)
    expect(result.resources.gate).toBe('unverified')
  })

  test('Given 分数不可比 When 比较 Then 资源也标记未评估', () => {
    const baseline: ShadowRunResult = { ...withCost('b', 0.6, 1, 1000), benchmarkVersion: 1 }
    const candidate: ShadowRunResult = { ...withCost('c', 0.9, 2, 2000), benchmarkVersion: 2 }
    const result = compareShadowRuns(baseline, candidate, { maxCostIncreaseRatio: 0.2 })
    expect(result.comparable).toBe(false)
    expect(result.resources.gate).toBe('unverified')
    expect(result.resources.reasons.join()).toContain('分数不可比')
  })

  test('Given 负成本或非有限值 When 比较 Then 按未记录处理', () => {
    const result = compareShadowRuns(withCost('b', 0.6, -1, Number.NaN), withCost('c', 0.9, 1, 1000))
    expect(result.resources.baselineCostUsd).toBeNull()
    expect(result.resources.baselineDurationMs).toBeNull()
  })
})

describe('describeShadowResources（资源表述）', () => {
  test('Given 门禁未通过 When 描述 Then 带警告与比例', () => {
    const result = compareShadowRuns(
      { label: 'b', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'a', score: 0.6 }], costUsd: 1, durationMs: 1000 },
      { label: 'c', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'a', score: 0.9 }], costUsd: 1.5, durationMs: 1000 },
      { maxCostIncreaseRatio: 0.2 },
    )
    const text = describeShadowComparison(result)
    expect(text).toContain('资源门禁未通过')
    expect(text).toContain('+50.0%')
  })

  test('Given 未配置门禁且有数据 When 描述 Then 附变化比例', () => {
    const result = compareShadowRuns(
      { label: 'b', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'a', score: 0.6 }], costUsd: 1, durationMs: 1000 },
      { label: 'c', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'a', score: 0.9 }], costUsd: 0.8, durationMs: 1000 },
    )
    const text = describeShadowComparison(result)
    expect(text).toContain('成本 -20.0%')
  })

  test('Given 无可比数据 When 描述 Then 不出现资源句', () => {
    const result = compareShadowRuns(
      { label: 'b', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'a', score: 0.6 }] },
      { label: 'c', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'a', score: 0.9 }] },
    )
    expect(describeShadowComparison(result)).not.toContain('成本')
  })
})

describe('compareScoreboardEvaluations（成本透传）', () => {
  const benchmark = {
    id: 'shadow-cost-fixture',
    title: '成本透传夹具',
    description: '仅用于测试',
    targetAgentId: 'code-reviewer' as const,
    runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    runsPerCase: 1,
    targetScore: 80,
    cases: ['c1'],
    createdAt: '2026-10-29T00:00:00Z',
    updatedAt: '2026-10-29T00:00:00Z',
  } as unknown as import('./types').BenchmarkConfig

  const evaluation = (agentVersion: number, costUsd: number | null, durationMs: number | null) => ({
    time: '2026-10-29T00:00:00Z',
    agentVersion,
    score: 0,
    costUsd,
    durationMs,
    runtime: { provider: 'deepseek', modelId: 'deepseek-v4-flash' },
    cases: [{ caseId: 'c1', score: 80, runs: [] }],
  }) as unknown as import('./types').BenchmarkEvaluation

  test('Given 评测带成本与耗时 When 比较 Then 直接进入资源判定', async () => {
    const { compareScoreboardEvaluations } = await import('./shadow-comparison')
    const result = compareScoreboardEvaluations({
      benchmark,
      baseline: evaluation(1, 0.02, 5000),
      candidate: evaluation(2, 0.05, 6000),
      maxCostIncreaseRatio: 1,
      maxLatencyIncreaseRatio: 0.1,
    })
    expect(result.resources.baselineCostUsd).toBeCloseTo(0.02, 6)
    expect(result.resources.costIncreaseRatio).toBeCloseTo(1.5, 5)
    expect(result.resources.gate).toBe('cost_exceeded')
  })

  test('Given 评测未记录成本 When 配置门禁 Then 门禁不可核验', async () => {
    const { compareScoreboardEvaluations } = await import('./shadow-comparison')
    const result = compareScoreboardEvaluations({
      benchmark,
      baseline: evaluation(1, null, null),
      candidate: evaluation(2, 0.05, 6000),
      maxCostIncreaseRatio: 0.2,
    })
    expect(result.resources.gate).toBe('unverified')
    expect(result.resources.reasons.join()).toContain('成本')
  })
})
