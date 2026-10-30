/**
 * 影子对比：把同一基准下基线侧与被迁移候选侧的评测结果放在一起比较。
 *
 * 只在两侧**确实可比**时给出结论：基准版本、rubric 版本与 case 集合必须一致，
 * 且每个 case 两侧都有有效分数。缺分、失败、越界一律判为不可比并说明原因——
 * 不把缺失分数当 0，也不用部分 case 的平均值冒充结论。
 *
 * 分数的结论之外，还会给出成本与延迟的变化比例，并可按配置的门禁判定"更贵/更慢
 * 到不可接受"。资源数据缺失时不假装通过：门禁状态记为 unverified 并写明原因。
 *
 * 纯函数，不写任何状态：本模块只负责判定与差值，不激活能力、不落盘、不重跑。
 * 真实影子流量采集、Provider 账单核对与人工验收不在本模块范围内。
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
  /** 该侧总成本（美元）；null/缺省表示未记录，不补 0。 */
  costUsd?: number | null
  /** 该侧总耗时（毫秒）；null/缺省表示未记录，不补 0。 */
  durationMs?: number | null
}

export interface ShadowCaseComparison {
  caseId: string
  baseline: number
  candidate: number
  delta: number
}

export interface ShadowResourceComparison {
  baselineCostUsd: number | null
  candidateCostUsd: number | null
  costDeltaUsd: number | null
  /** 相对基线成本的增幅；基线为 0 或缺失时无法计算，记 null。 */
  costIncreaseRatio: number | null
  baselineDurationMs: number | null
  candidateDurationMs: number | null
  durationIncreaseRatio: number | null
  /** pass：未超阈值或未配置阈值；unverified：配置了门禁但数据缺失；exceeded 两种为超限。 */
  gate: 'pass' | 'cost_exceeded' | 'latency_exceeded' | 'unverified'
  reasons: string[]
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
  /** 成本与延迟的变化及门禁结果；分数不可比时不评估，记为 unverified。 */
  resources: ShadowResourceComparison
}

export interface ShadowComparisonOptions {
  /** 可选的基准 case 清单；提供时两侧必须完整匹配。 */
  expectedCaseIds?: string[]
  /** 判定"有差异"的最小均值差；绝对值小于该阈值视为无差异。默认 0.02。 */
  deltaThreshold?: number
  /** 允许的最大成本增幅（0.2 = 最多贵 20%）；不设置则不做成本门禁。 */
  maxCostIncreaseRatio?: number
  /** 允许的最大耗时增幅；不设置则不做延迟门禁。 */
  maxLatencyIncreaseRatio?: number
}

const isValidScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1


const finiteNonNegative = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** 相对增幅；基线为 0 或缺失时无法给出比例（不写成 Infinity 或 100%）。 */
const increaseRatio = (base: number | null, candidate: number | null): number | null =>
  base === null || candidate === null || base <= 0 ? null : (candidate - base) / base

/** 计算成本与延迟变化并按需判定门禁；分数不可比时不做资源评估。 */
function evaluateResources(
  baseline: ShadowRunResult,
  candidate: ShadowRunResult,
  options: ShadowComparisonOptions,
  comparable: boolean,
): ShadowResourceComparison {
  const baselineCostUsd = finiteNonNegative(baseline.costUsd)
  const candidateCostUsd = finiteNonNegative(candidate.costUsd)
  const baselineDurationMs = finiteNonNegative(baseline.durationMs)
  const candidateDurationMs = finiteNonNegative(candidate.durationMs)
  const costIncreaseRatio = increaseRatio(baselineCostUsd, candidateCostUsd)
  const durationIncreaseRatio = increaseRatio(baselineDurationMs, candidateDurationMs)
  const reasons: string[] = []

  if (!comparable) {
    reasons.push('分数不可比，未评估成本与延迟变化')
    return {
      baselineCostUsd,
      candidateCostUsd,
      costDeltaUsd: baselineCostUsd === null || candidateCostUsd === null ? null : candidateCostUsd - baselineCostUsd,
      costIncreaseRatio,
      baselineDurationMs,
      candidateDurationMs,
      durationIncreaseRatio,
      gate: 'unverified',
      reasons,
    }
  }

  const base = {
    baselineCostUsd,
    candidateCostUsd,
    costDeltaUsd: baselineCostUsd === null || candidateCostUsd === null ? null : candidateCostUsd - baselineCostUsd,
    costIncreaseRatio,
    baselineDurationMs,
    candidateDurationMs,
    durationIncreaseRatio,
  }

  const costGate = options.maxCostIncreaseRatio
  const latencyGate = options.maxLatencyIncreaseRatio
  if ((costGate !== undefined && finiteNonNegative(costGate) === null) ||
      (latencyGate !== undefined && finiteNonNegative(latencyGate) === null)) {
    return { ...base, gate: 'unverified', reasons: ['资源门禁阈值无效，门禁未核验'] }
  }
  if (costGate === undefined && latencyGate === undefined) {
    return { ...base, gate: 'pass', reasons }
  }

  // 配置了门禁但数据缺失：明确记为未核验，不当成通过。
  const missing: string[] = []
  if (costGate !== undefined && costIncreaseRatio === null) missing.push('成本')
  if (latencyGate !== undefined && durationIncreaseRatio === null) missing.push('延迟')
  if (missing.length) {
    reasons.push(`${missing.join('、')}数据缺失，门禁未核验`)
    return { ...base, gate: 'unverified', reasons }
  }

  if (costGate !== undefined && costIncreaseRatio !== null && costIncreaseRatio > costGate) {
    reasons.push(`成本增幅 ${(costIncreaseRatio * 100).toFixed(1)}% 超过允许的 ${(costGate * 100).toFixed(1)}%`)
    return { ...base, gate: 'cost_exceeded', reasons }
  }
  if (latencyGate !== undefined && durationIncreaseRatio !== null && durationIncreaseRatio > latencyGate) {
    reasons.push(`耗时增幅 ${(durationIncreaseRatio * 100).toFixed(1)}% 超过允许的 ${(latencyGate * 100).toFixed(1)}%`)
    return { ...base, gate: 'latency_exceeded', reasons }
  }
  return { ...base, gate: 'pass', reasons }
}

/** 比较两侧评测结果；不可比时明确返回原因与 inconclusive 结论。 */
export function compareShadowRuns(
  baseline: ShadowRunResult,
  candidate: ShadowRunResult,
  options: ShadowComparisonOptions = {},
): ShadowComparison {
  const threshold = options.deltaThreshold ?? 0.02
  const reasons: string[] = []

  if (finiteNonNegative(threshold) === null) reasons.push('差值阈值无效')
  if (baseline.cases.length === 0 || candidate.cases.length === 0) reasons.push('评测 case 为空')

  if (baseline.benchmarkVersion !== candidate.benchmarkVersion) {
    reasons.push(`基准版本不同：${baseline.benchmarkVersion} vs ${candidate.benchmarkVersion}`)
  }
  if (baseline.rubricVersion !== candidate.rubricVersion) {
    reasons.push(`rubric 版本不同：${baseline.rubricVersion} vs ${candidate.rubricVersion}`)
  }

  const baselineIds = baseline.cases.map((item) => item.caseId)
  const candidateIds = candidate.cases.map((item) => item.caseId)
  if (options.expectedCaseIds) {
    const expected = new Set(options.expectedCaseIds)
    const matches = (ids: string[]) => ids.length === expected.size && ids.every((id) => expected.has(id))
    if (expected.size === 0 || expected.size !== options.expectedCaseIds.length || !matches(baselineIds) || !matches(candidateIds)) {
      reasons.push('评测与基准 case 不匹配，或基准 case 清单为空或重复')
    }
  }
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
      resources: evaluateResources(baseline, candidate, options, false),
    }
  }

  const meanBaseline = cases.reduce((sum, item) => sum + item.baseline, 0) / cases.length
  const meanCandidate = cases.reduce((sum, item) => sum + item.candidate, 0) / cases.length
  const meanDelta = meanCandidate - meanBaseline
  const improved = cases.filter((item) => item.delta > 0).length
  const regressed = cases.filter((item) => item.delta < 0).length
  const unchanged = cases.length - improved - regressed
  const verdict: ShadowComparison['verdict'] = meanDelta === 0
    ? 'no_difference'
    : meanDelta >= threshold
    ? 'candidate_better'
    : meanDelta <= -threshold
      ? 'candidate_worse'
      : 'no_difference'

  return {
    comparable: true,
    reasons,
    cases,
    meanBaseline,
    meanCandidate,
    meanDelta,
    improved,
    regressed,
    unchanged,
    verdict,
    resources: evaluateResources(baseline, candidate, options, true),
  }
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
  const base = `影子对比：${trend}（均值 ${meanBaseline.toFixed(3)} → ${meanCandidate.toFixed(3)}，差值 ${sign}${delta.toFixed(3)}；改善 ${comparison.improved}、退步 ${comparison.regressed}、持平 ${comparison.unchanged}）`
  const resourceNote = describeShadowResources(comparison.resources)
  return resourceNote ? `${base}；${resourceNote}` : base
}

/** 成本与延迟的表述：超限、未核验与"未记录"三种情况分别说清。 */
export function describeShadowResources(resources: ShadowResourceComparison): string | undefined {
  const percent = (ratio: number | null): string | null => (ratio === null ? null : `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}%`)
  const changes: string[] = []
  const cost = percent(resources.costIncreaseRatio)
  if (cost) changes.push(`成本 ${cost}`)
  const latency = percent(resources.durationIncreaseRatio)
  if (latency) changes.push(`耗时 ${latency}`)
  const summary = changes.length ? changes.join('、') : undefined

  if (resources.gate === 'cost_exceeded' || resources.gate === 'latency_exceeded') {
    return `⚠️ 资源门禁未通过：${resources.reasons.join('；')}${summary ? `（${summary}）` : ''}`
  }
  if (resources.gate === 'unverified') {
    return `资源未核验：${resources.reasons.join('；')}`
  }
  return summary
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
    costUsd: finiteNonNegative(evaluation.costUsd),
    durationMs: finiteNonNegative(evaluation.durationMs),
  }
}

export interface ScoreboardShadowInput {
  benchmark: import('./types').BenchmarkConfig
  baseline: import('./types').BenchmarkEvaluation
  candidate: import('./types').BenchmarkEvaluation
  deltaThreshold?: number
  maxCostIncreaseRatio?: number
  maxLatencyIncreaseRatio?: number
}

/**
 * 用同一次基准的定义比较两条已落盘评测（基线版本 vs 候选版本）。
 *
 * 版本号来自基准定义本身：两侧共用同一 benchmark/rubric 版本，因此可比性只取决于
 * case 集合与分数完整性。历史评测未记录基准版本，调用方须自行核验两次评测
 * 确实使用了该基准定义，不能据此证明版本来源。
 */
export function compareScoreboardEvaluations(input: ScoreboardShadowInput): ShadowComparison {
  const benchmarkVersion = (input.benchmark as { version?: number }).version ?? 1
  const rubricVersion = (input.benchmark as { rubricVersion?: number }).rubricVersion ?? 1
  return compareShadowRuns(
    shadowRunFromEvaluation(input.baseline, { label: 'baseline', benchmarkVersion, rubricVersion }),
    shadowRunFromEvaluation(input.candidate, { label: 'candidate', benchmarkVersion, rubricVersion }),
    {
      expectedCaseIds: input.benchmark.cases,
      ...(input.deltaThreshold === undefined ? {} : { deltaThreshold: input.deltaThreshold }),
      ...(input.maxCostIncreaseRatio === undefined ? {} : { maxCostIncreaseRatio: input.maxCostIncreaseRatio }),
      ...(input.maxLatencyIncreaseRatio === undefined ? {} : { maxLatencyIncreaseRatio: input.maxLatencyIncreaseRatio }),
    },
  )
}

/** 同上，但先按 scoreboard 评测构造两侧输入再比较（供调用方一次写全）。 */
export function compareScoreboardResources(input: ScoreboardShadowInput): ShadowResourceComparison {
  return compareScoreboardEvaluations(input).resources
}
