/**
 * 影子对比：把同一基准下基线侧与被迁移候选侧的评测结果放在一起比较。
 *
 * 只在两侧**确实可比**时给出结论：基准版本、rubric 版本与 case 集合必须一致，
 * 且每个 case 两侧都有有效分数。缺分、失败、越界一律判为不可比并说明原因——
 * 不把缺失分数当 0，也不用部分 case 的平均值冒充结论。
 *
 * 纯函数，不写任何状态：本模块只负责判定与差值，不激活能力、不落盘、不重跑。
 * 真实影子流量采集、Provider 成本核对与人工验收不在本模块范围内。
 */

export interface ShadowCaseScore {
  caseId: string
  /** 有效分数（0..1）；null 表示该 case 没有可核验分数。 */
  score: number | null
}

export interface ShadowRunResult {
  /** 侧标识，仅用于报告，例如 baseline / candidate。 */
  label: string
  benchmarkVersion: number
  rubricVersion: number
  cases: ShadowCaseScore[]
}

export interface ShadowCaseComparison {
  caseId: string
  baseline: number
  candidate: number
  delta: number
}

export interface ShadowComparison {
  /** 两侧是否可比；false 时 verdict 固定为 inconclusive。 */
  comparable: boolean
  /** 不可比原因；可比时为空。 */
  reasons: string[]
  cases: ShadowCaseComparison[]
  meanBaseline: number | null
  meanCandidate: number | null
  /** 候选侧均值减基线侧均值；不可比时为 null。 */
  meanDelta: number | null
  improved: number
  regressed: number
  unchanged: number
  verdict: 'candidate_better' | 'candidate_worse' | 'no_difference' | 'inconclusive'
}

export interface ShadowComparisonOptions {
  /** 判定"有差异"的最小均值差；绝对值小于该阈值视为无差异。默认 0.02。 */
  deltaThreshold?: number
}

const isValidScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** 比较两侧评测结果；不可比时明确返回原因与 inconclusive 结论。 */
export function compareShadowRuns(
  baseline: ShadowRunResult,
  candidate: ShadowRunResult,
  options: ShadowComparisonOptions = {},
): ShadowComparison {
  const threshold = options.deltaThreshold ?? 0.02
  const reasons: string[] = []

  if (baseline.benchmarkVersion !== candidate.benchmarkVersion) {
    reasons.push(`基准版本不同：${baseline.benchmarkVersion} vs ${candidate.benchmarkVersion}`)
  }
  if (baseline.rubricVersion !== candidate.rubricVersion) {
    reasons.push(`rubric 版本不同：${baseline.rubricVersion} vs ${candidate.rubricVersion}`)
  }

  const baselineIds = baseline.cases.map((item) => item.caseId)
  const candidateIds = candidate.cases.map((item) => item.caseId)
  // 重复只在单侧内部判定：两侧共有同一 case 才是可比的前提，不是重复。
  const duplicatesWithin = (ids: string[]): string[] => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  const duplicateIds = [...duplicatesWithin(baselineIds), ...duplicatesWithin(candidateIds)]
  if (duplicateIds.length) {
    reasons.push(`case 重复：${[...new Set(duplicateIds)].join('、')}`)
  }
  const missingInCandidate = baselineIds.filter((id) => !candidateIds.includes(id))
  const extraInCandidate = candidateIds.filter((id) => !baselineIds.includes(id))
  if (missingInCandidate.length) reasons.push(`候选缺少 case：${missingInCandidate.join('、')}`)
  if (extraInCandidate.length) reasons.push(`候选多出 case：${extraInCandidate.join('、')}`)

  const baselineById = new Map(baseline.cases.map((item) => [item.caseId, item.score]))
  const candidateById = new Map(candidate.cases.map((item) => [item.caseId, item.score]))
  const invalid: string[] = []
  const cases: ShadowCaseComparison[] = []
  for (const caseId of baselineIds) {
    if (!candidateById.has(caseId)) continue
    const left = baselineById.get(caseId)
    const right = candidateById.get(caseId)
    if (!isValidScore(left) || !isValidScore(right)) {
      invalid.push(caseId)
      continue
    }
    cases.push({ caseId, baseline: left, candidate: right, delta: right - left })
  }
  if (invalid.length) reasons.push(`缺少有效分数：${invalid.join('、')}`)

  if (reasons.length) {
    return {
      comparable: false,
      reasons,
      cases,
      meanBaseline: null,
      meanCandidate: null,
      meanDelta: null,
      improved: 0,
      regressed: 0,
      unchanged: 0,
      verdict: 'inconclusive',
    }
  }

  const meanBaseline = cases.reduce((sum, item) => sum + item.baseline, 0) / cases.length
  const meanCandidate = cases.reduce((sum, item) => sum + item.candidate, 0) / cases.length
  const meanDelta = meanCandidate - meanBaseline
  const improved = cases.filter((item) => item.delta > 0).length
  const regressed = cases.filter((item) => item.delta < 0).length
  const unchanged = cases.length - improved - regressed
  const verdict: ShadowComparison['verdict'] = meanDelta >= threshold
    ? 'candidate_better'
    : meanDelta <= -threshold
      ? 'candidate_worse'
      : 'no_difference'

  return { comparable: true, reasons, cases, meanBaseline, meanCandidate, meanDelta, improved, regressed, unchanged, verdict }
}

/** 生成面向人工判断的一句话结论；不可比时明确写出原因，不与"无差异"混同。 */
export function describeShadowComparison(comparison: ShadowComparison): string {
  if (!comparison.comparable) {
    return `影子对比不可比，不下结论：${comparison.reasons.join('；') || '原因未知'}`
  }
  const delta = comparison.meanDelta
  const meanBaseline = comparison.meanBaseline
  const meanCandidate = comparison.meanCandidate
  if (delta === null || meanBaseline === null || meanCandidate === null) return '影子对比不可比，不下结论'
  const sign = delta > 0 ? '+' : ''
  const trend = comparison.verdict === 'candidate_better'
    ? '候选更好'
    : comparison.verdict === 'candidate_worse'
      ? '候选更差'
      : '无显著差异'
  return `影子对比：${trend}（均值 ${meanBaseline.toFixed(3)} → ${meanCandidate.toFixed(3)}，差值 ${sign}${delta.toFixed(3)}；改善 ${comparison.improved}、退步 ${comparison.regressed}、持平 ${comparison.unchanged}）`
}

/**
 * 把 scoreboard 里的一次评测转成影子对比输入。
 *
 * scoreboard 分数是 0..100，本模块统一用 0..1；越界或非有限的 case 分数按"缺分"
 * 处理（由 compareShadowRuns 判为不可比），不做裁剪、不按 0 计。
 */
export function shadowRunFromEvaluation(evaluation: import('./types').BenchmarkEvaluation, options: {
  label: string
  benchmarkVersion: number
  rubricVersion: number
}): ShadowRunResult {
  return {
    label: options.label,
    benchmarkVersion: options.benchmarkVersion,
    rubricVersion: options.rubricVersion,
    cases: evaluation.cases.map((item) => ({
      caseId: item.caseId,
      score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score / 100 : null,
    })),
  }
}

export interface ScoreboardShadowInput {
  benchmark: import('./types').BenchmarkConfig
  baseline: import('./types').BenchmarkEvaluation
  candidate: import('./types').BenchmarkEvaluation
  deltaThreshold?: number
}

/**
 * 用同一次基准的定义比较两条已落盘评测（基线版本 vs 候选版本）。
 *
 * 版本号来自基准定义本身：两侧共用同一 benchmark/rubric 版本，因此可比性只取决于
 * case 集合与分数完整性——这正是"影子"的前提：定义没变，只换被测对象。
 */
export function compareScoreboardEvaluations(input: ScoreboardShadowInput): ShadowComparison {
  const benchmarkVersion = (input.benchmark as { version?: number }).version ?? 1
  const rubricVersion = (input.benchmark as { rubricVersion?: number }).rubricVersion ?? 1
  return compareShadowRuns(
    shadowRunFromEvaluation(input.baseline, { label: 'baseline', benchmarkVersion, rubricVersion }),
    shadowRunFromEvaluation(input.candidate, { label: 'candidate', benchmarkVersion, rubricVersion }),
    input.deltaThreshold === undefined ? {} : { deltaThreshold: input.deltaThreshold },
  )
}
