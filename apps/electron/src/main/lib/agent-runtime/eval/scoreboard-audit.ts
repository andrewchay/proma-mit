/**
 * 评测样本的「可审计性」报告：把已落盘的数据整理成能回答三个问题的形式——
 * 这条记录当时的来源齐不齐、样本量够不够、现在能不能拿去做影子对比。
 *
 * 边界：
 * - 只读，不改写任何记录；**历史缺口不回填**，缺来源就标缺来源。
 * - 不把"同一基准下的两条记录"直接当成可比：还要三条输入来源（素材/评判/运行配置）都冻结且一致。
 * - 统计量只用记录里实际存在的数据；缺失按缺失计，不当 0、不当通过。
 */

import type { BenchmarkEvaluation, Scoreboard, ScoreboardCaseRun } from './types'
import { readScoreboard } from './benchmark-store'

/** 单条评测记录的来源审计结论。 */
export interface EvaluationSourceAudit {
  /** 在 scoreboard 中的下标（存储顺序，便于人工定位）。 */
  index: number
  time: string
  agentVersion: number
  /** 是否冻结了基准来源（版本 + rubric 版本 + 定义哈希）。 */
  hasDefinition: boolean
  definitionHash?: string
  rubricVersion?: number
  /** 三类输入来源是否冻结。 */
  hasCaseMaterial: boolean
  hasJudge: boolean
  hasRunConfig: boolean
  /** 人类可读的缺失项；为空表示来源齐备。 */
  missing: string[]
  /** 该记录内部是否自洽：每个 case 都有 run，且 run 都带题目与评分规则摘要。 */
  internalComplete: boolean
  caseCount: number
  runCount: number
  /** 具备进入影子对比的前提（来源齐备且内部自洽）。 */
  comparableReady: boolean
}

/** 全体样本的质量画像。 */
export interface SampleQualityReport {
  evaluationCount: number
  /** 来源齐备、可进入对比的记录数。 */
  comparableReadyCount: number
  /** 缺少基准来源的历史记录数（这些永远不进对比，也不回填）。 */
  legacyCount: number
  /** 来源齐备且定义一致的相邻记录对数（真正能跑一次对比的次数）。 */
  comparablePairs: number
  /** 每个 case 的 run 数分布；样本集为空时为 null。 */
  runsPerCase: { min: number; median: number; max: number } | null
  /** 只有 1 次 run 的 case 数：抖动无法从数据里看出来。 */
  singleRunCases: number
  /** 缺少题目/评分规则摘要的 run 数。 */
  runsMissingRubricDigest: number
  /** 记录了评判者身份的记录数（未记录 = 无法判断评判实现是否一致）。 */
  judgeRecordedCount: number
  /** 出现频次最高的阻塞原因，按次数降序；用于说明"为什么大多数记录不可比"。 */
  blockingReasons: Array<{ reason: string; count: number }>
}

export interface ScoreboardAudit {
  benchmarkId: string
  evaluations: EvaluationSourceAudit[]
  quality: SampleQualityReport
  /** 面向人的结论句，明确区分"样本不足"与"来源缺失"。 */
  summary: string
}

const RUBRIC_DIGEST = /^[a-f0-9]{64}$/

function runDigestMissing(run: ScoreboardCaseRun): boolean {
  return typeof run.caseTextRubricSha256 !== 'string' || !RUBRIC_DIGEST.test(run.caseTextRubricSha256)
}

/** 单条记录的审计：来源齐备性与内部自洽性分开判，避免互相掩盖。 */
export function auditEvaluation(evaluation: BenchmarkEvaluation, index: number): EvaluationSourceAudit {
  const definition = evaluation.definition
  const missing: string[] = []
  if (!definition) {
    missing.push('基准来源未冻结（历史记录）')
  } else {
    if (!definition.caseMaterialHash) missing.push('案例素材来源未冻结')
    if (!definition.judgeHash) missing.push('评判实现未冻结')
    if (!definition.runConfigHash) missing.push('运行配置未冻结')
  }
  const cases = Array.isArray(evaluation.cases) ? evaluation.cases : []
  const runs = cases.flatMap(item => Array.isArray(item.runs) ? item.runs : [])
  const runsMissingRubricDigest = runs.filter(runDigestMissing).length
  const casesWithoutRuns = cases.filter(item => !Array.isArray(item.runs) || item.runs.length === 0).length
  if (runsMissingRubricDigest > 0) missing.push(`题目或评分规则摘要缺失 ${runsMissingRubricDigest} 次`)
  if (casesWithoutRuns > 0) missing.push(`缺少运行明细的 case ${casesWithoutRuns} 个`)
  const hasCaseMaterial = Boolean(definition?.caseMaterialHash)
  const hasJudge = Boolean(definition?.judgeHash)
  const hasRunConfig = Boolean(definition?.runConfigHash)
  const internalComplete = cases.length > 0 && casesWithoutRuns === 0 && runsMissingRubricDigest === 0
  return {
    index,
    time: evaluation.time,
    agentVersion: evaluation.agentVersion,
    hasDefinition: Boolean(definition),
    ...(definition?.definitionHash ? { definitionHash: definition.definitionHash } : {}),
    ...(definition?.rubricVersion === undefined ? {} : { rubricVersion: definition.rubricVersion }),
    hasCaseMaterial,
    hasJudge,
    hasRunConfig,
    missing,
    internalComplete,
    caseCount: cases.length,
    runCount: runs.length,
    comparableReady: Boolean(definition) && hasCaseMaterial && hasJudge && hasRunConfig && internalComplete,
  }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/** 定义一致（版本、rubric、哈希都相同）才可能被拿来对比。 */
function sameDefinition(left: EvaluationSourceAudit, right: EvaluationSourceAudit): boolean {
  return Boolean(left.definitionHash) && left.definitionHash === right.definitionHash && left.rubricVersion === right.rubricVersion
}

/**
 * 审核一份 scoreboard：逐条来源审计 + 样本质量画像。
 *
 * 只读纯函数，便于在测试与 UI 里复用；benchmarkId 仅用于回填结果标识。
 */
export function auditScoreboard(benchmarkId: string, scoreboard: Scoreboard): ScoreboardAudit {
  const evaluations = (scoreboard.evaluations ?? []).map(auditEvaluation)
  const readyIndexes = evaluations.filter(item => item.comparableReady)
  let comparablePairs = 0
  for (let i = 0; i < readyIndexes.length; i++) {
    for (let j = i + 1; j < readyIndexes.length; j++) {
      if (sameDefinition(readyIndexes[i]!, readyIndexes[j]!)) comparablePairs++
    }
  }

  const perCaseRuns = new Map<string, number>()
  let runsMissingRubricDigest = 0
  let judgeRecordedCount = 0
  for (const evaluation of scoreboard.evaluations ?? []) {
    if (evaluation.judge) judgeRecordedCount++
    for (const item of evaluation.cases ?? []) {
      perCaseRuns.set(item.caseId, (perCaseRuns.get(item.caseId) ?? 0) + (item.runs?.length ?? 0))
      runsMissingRubricDigest += (item.runs ?? []).filter(runDigestMissing).length
    }
  }
  const runCounts = [...perCaseRuns.values()]
  const singleRunCases = runCounts.filter(count => count === 1).length

  const blocking = new Map<string, number>()
  for (const item of evaluations) {
    for (const reason of item.missing) blocking.set(reason, (blocking.get(reason) ?? 0) + 1)
  }

  const quality: SampleQualityReport = {
    evaluationCount: evaluations.length,
    comparableReadyCount: readyIndexes.length,
    legacyCount: evaluations.filter(item => !item.hasDefinition).length,
    comparablePairs,
    runsPerCase: runCounts.length === 0 ? null : { min: Math.min(...runCounts), median: median(runCounts), max: Math.max(...runCounts) },
    singleRunCases,
    runsMissingRubricDigest,
    judgeRecordedCount,
    blockingReasons: [...blocking.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count),
  }
  return { benchmarkId, evaluations, quality, summary: describeSampleAudit(quality) }
}

/** 一句话结论：先回答"能不能对比"，再说明卡在哪。 */
export function describeSampleAudit(quality: SampleQualityReport): string {
  if (quality.evaluationCount === 0) return '样本审计：这个基准还没有任何评测记录。'
  if (quality.comparableReadyCount === 0) {
    const reasons = quality.blockingReasons.slice(0, 3).map(item => `${item.reason}（${item.count} 条）`).join('；')
    return `样本审计：${quality.evaluationCount} 条记录没有一条来源齐备，全部不可比${reasons ? `，主要缺口：${reasons}` : ''}。历史缺口不回填。`
  }
  const sampleNote = quality.singleRunCases > 0 ? `有 ${quality.singleRunCases} 个 case 只有 1 次运行，抖动无法从数据里看出来。` : ''
  const pairNote = quality.comparablePairs === 0 ? '来源齐备但没有两条定义一致的记录，还不能做对比。' : `可对比记录对 ${quality.comparablePairs} 组。`
  return `样本审计：${quality.evaluationCount} 条记录中 ${quality.comparableReadyCount} 条来源齐备；${pairNote}${sampleNote}`
}

/** 读取一个基准的 scoreboard 并审计；基准或历史不可读时抛错由调用方处理。 */
export function auditBenchmarkSamples(benchmarkId: string): ScoreboardAudit {
  return auditScoreboard(benchmarkId, readScoreboard(benchmarkId))
}
