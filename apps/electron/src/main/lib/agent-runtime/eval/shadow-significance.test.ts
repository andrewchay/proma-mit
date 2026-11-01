import { describe, expect, test } from 'bun:test'
import { compareShadowRuns, describeShadowComparison, evaluateShadowSignificance } from './shadow-comparison'

/** 用同一份增量构造两侧：delta 逐 case 给定。 */
const sides = (deltas: number[], baselineScore = 0.5) => ({
  baseline: {
    label: 'baseline',
    benchmarkVersion: 1,
    rubricVersion: 1,
    cases: deltas.map((_, index) => ({ caseId: `c${index}`, score: baselineScore })),
  },
  candidate: {
    label: 'candidate',
    benchmarkVersion: 1,
    rubricVersion: 1,
    cases: deltas.map((delta, index) => ({ caseId: `c${index}`, score: baselineScore + delta })),
  },
})

describe('显著性（符号检验）', () => {
  test('Given 六例全部改善 When 比较 Then 达显著', () => {
    const input = sides([0.1, 0.1, 0.1, 0.1, 0.1, 0.1])
    const result = compareShadowRuns(input.baseline, input.candidate)
    expect(result.verdict).toBe('candidate_better')
    expect(result.significance).toMatchObject({ method: 'sign_test', pairs: 6, improvedPairs: 6, regressedPairs: 0, significant: true })
    expect(result.significance.pValue).toBeCloseTo(0.03125, 5)
    expect(describeShadowComparison(result)).toContain('方向一致')
  })

  test('Given 五例全部改善 When 比较 Then 不达显著并给出提示', () => {
    const input = sides([0.1, 0.1, 0.1, 0.1, 0.1])
    const result = compareShadowRuns(input.baseline, input.candidate)
    expect(result.verdict).toBe('candidate_better')
    expect(result.significance.significant).toBe(false)
    expect(result.significance.pValue).toBeCloseTo(0.0625, 5)
    const text = describeShadowComparison(result)
    expect(text).toContain('未达统计显著')
    expect(text).toContain('不能排除噪声')
  })

  test('Given 改善与退步混杂 When 比较 Then 不做显著结论', () => {
    const input = sides([0.1, 0.1, 0.1, 0.1, -0.1, -0.1])
    const result = compareShadowRuns(input.baseline, input.candidate)
    expect(result.significance.pairs).toBe(6)
    expect(result.significance.improvedPairs).toBe(4)
    expect(result.significance.regressedPairs).toBe(2)
    expect(result.significance.significant).toBe(false)
    expect(result.significance.pValue).toBeCloseTo(0.6875, 5)
  })

  test('Given 全部差值都在阈值以内 When 比较 Then 明确说明无法判断方向', () => {
    const input = sides([0.01, -0.01, 0, 0.005])
    const result = compareShadowRuns(input.baseline, input.candidate)
    expect(result.significance.pairs).toBe(0)
    expect(result.significance.pValue).toBeNull()
    expect(result.significance.significant).toBe(false)
    expect(result.significance.note).toContain('没有超过阈值')
  })

  test('Given 配对数低于下限 When 比较 Then 即使 p 小也不算显著', () => {
    const input = sides([0.2, 0.2, 0.2])
    const result = compareShadowRuns(input.baseline, input.candidate, { minSignificancePairs: 5 })
    expect(result.significance.pairs).toBe(3)
    expect(result.significance.pValue).toBeCloseTo(0.25, 5)
    expect(result.significance.significant).toBe(false)
    expect(result.significance.note).toContain('少于下限')
  })

  test('Given 可比性不足 When 比较 Then 显著性显式未做而不是缺席', () => {
    const result = compareShadowRuns(
      { label: 'baseline', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'c1', score: 0.5 }] },
      { label: 'candidate', benchmarkVersion: 2, rubricVersion: 1, cases: [{ caseId: 'c1', score: 0.8 }] },
    )
    expect(result.comparable).toBe(false)
    expect(result.significance.significant).toBe(false)
    expect(result.significance.note).toContain('未做显著性判断')
  })

  test('Given 阈值与显著性水平可配置 When 计算 Then 按配置生效', () => {
    const cases = [
      { caseId: 'a', baseline: 0.5, candidate: 0.53, delta: 0.03 },
      { caseId: 'b', baseline: 0.5, candidate: 0.53, delta: 0.03 },
      { caseId: 'c', baseline: 0.5, candidate: 0.53, delta: 0.03 },
      { caseId: 'd', baseline: 0.5, candidate: 0.53, delta: 0.03 },
      { caseId: 'e', baseline: 0.5, candidate: 0.53, delta: 0.03 },
    ]
    expect(evaluateShadowSignificance(cases, { deltaThreshold: 0.02, minPairs: 5 }).pairs).toBe(5)
    expect(evaluateShadowSignificance(cases, { deltaThreshold: 0.05, minPairs: 5 }).pairs).toBe(0)
    const five = evaluateShadowSignificance(cases, { deltaThreshold: 0.02, minPairs: 5, alpha: 0.07 })
    expect(five.significant).toBe(true)
  })

  test('Given 分数越界或缺失 When 比较 Then 不进入显著性计算', () => {
    const result = compareShadowRuns(
      { label: 'baseline', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'c1', score: 0.5 }] },
      { label: 'candidate', benchmarkVersion: 1, rubricVersion: 1, cases: [{ caseId: 'c1', score: 1.5 }] },
    )
    expect(result.comparable).toBe(false)
    expect(result.significance.pairs).toBe(0)
  })
})
