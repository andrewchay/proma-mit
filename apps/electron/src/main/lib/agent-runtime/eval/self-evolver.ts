/**
 * SelfEvolver — 分数驱动的优化循环（借鉴 penguin `agent-optimization`，轻量化）。
 *
 * evidence → hypothesis(candidate) → evaluate → accept/rollback。
 * - Baseline：对冻结 Benchmark 全 Case 跑一次，得到当前 Reference 分数。
 * - 每个候选：先在当前 Reference 上做「版本快照」，应用候选后全 Case 评测；
 *   **只有分数严格高于 Reference 才接受**，否则回滚并保留 Reference。
 * - 只 append 被接受候选的成绩到 scoreboard；被拒候选仅作后续假设的参考。
 *
 * 本模块与具体 Agent 定义存储解耦：候选应用/回滚由调用方注入，便于单测与接入现有 runtime。
 */

import { appendEvaluation } from './benchmark-store'
import { freezeEvaluationDefinition } from './benchmark-versioning'
import { compareRecordedEvaluations, describeShadowComparison } from './shadow-comparison'
import { meanStd } from './evaluator'
import type { BenchmarkConfig, BenchmarkEvaluation, HeldOutReport, JudgeIdentity, ScoreboardCaseRun, SelfEvolveChange, SelfEvolveRoundResult } from './types'

/** 评测单个 Case × run 的分数（含成本/耗时可选）。null=评测失败。 */
export interface CaseEval {
  caseId: string
  score: number | null
  costUsd?: number | null
  durationMs?: number | null
  sessionId?: string
  /** 每次实际运行的原始记录；缺省表示调用方未提供明细。 */
  runs?: ScoreboardCaseRun[]
  /** 该评估的 trace 文件路径（决策序列 JSONL） */
  tracePath?: string
}

/** 评测一次状态（def）的 delegate：对 benchmark 内所有 case 各跑一次固定 run 数。 */
export type EvaluateState = (def: unknown, benchmark: BenchmarkConfig) => Promise<CaseEval[]>

/** 版本快照控制：快照当前、应用候选、回滚。 */
export interface StateGuard {
  snapshot(label: string): Promise<void>
  apply(change: SelfEvolveChange): Promise<void>
  restore(): Promise<void>
  /** 当前被测 Agent 状态版本 */
  version(): number
}

/** 候选生成：给定 baseline 失分信息，产出候选改动。返回空 = 本轮结束。 */
export type ProposeChange = (input: { benchmark: BenchmarkConfig; deficit: Array<{ caseId: string; score: number | null }>; round: number }) => Promise<SelfEvolveChange | null>

export interface EvolveInput {
  benchmark: BenchmarkConfig
  maxRounds: number
  /** 候选生成器（默认 = 无候选，仅产出 baseline） */
  propose: ProposeChange
  evaluate: EvaluateState
  state: StateGuard
  /** 本次评判者身份（评估器独立性审计），写入每条 evaluation */
  judge?: JudgeIdentity | null
  /** 被测方轮次上限；缺省与 evaluator 一致（12），参与运行配置来源冻结。 */
  maxTurns?: number
  /**
   * 可选：held-out 迁移评测（综述 §8.1.1）。对不参与优化的 held-out Case 集评测，
   * 在 baseline 与每个被接受候选上各跑一次并落盘——训练分涨而 held-out 不涨即为过拟合信号。
   */
  evaluateHeldOut?: EvaluateState
  /** held-out 分数相较于 baseline/reference 允许的最大下降；缺省 0，即不得下降。 */
  heldOutMaxRegression?: number
  /** 影子对比的分数差值阈值（默认 0.02）；用于区分噪声与提升。 */
  comparisonDeltaThreshold?: number
  /** 候选相对 Reference 允许的成本增幅；超出时对比报告标注 cost_exceeded。 */
  maxCostIncreaseRatio?: number
  /** 候选相对 Reference 允许的耗时增幅；超出时对比报告标注 latency_exceeded。 */
  maxLatencyIncreaseRatio?: number
}

export interface EvolveOutput {
  baseline: {
    agentVersion: number
    totalScore: number
    byCase: CaseEval[]
  }
  rounds: SelfEvolveRoundResult[]
  finalAcceptedVersion: number
  finalScore: number
}

/** 计算 Case 平均分（忽略 null；全 null → null）。 */
function averageCaseScore(cases: CaseEval[]): number | null {
  const scored = cases.filter((c) => c.score !== null)
  if (scored.length === 0) return null
  return scored.reduce((s, c) => s + (c.score as number), 0) / scored.length
}

/** 每个预期 case 都必须有有效分数，缺失不能折算为零。 */
function completeCaseScore(cases: CaseEval[], expected?: string[]): number | null {
  if (!cases.length || cases.some(item => item.score === null || !Number.isFinite(item.score) || item.score < 0 || item.score > 100)) return null
  const ids = new Set(cases.map(item => item.caseId))
  if (ids.size !== cases.length || (expected && (ids.size !== expected.length || expected.some(id => !ids.has(id))))) return null
  return averageCaseScore(cases)
}

/** 由完整 CaseEval 列表构造 held-out 报告。 */
function toHeldOutReport(byCase: CaseEval[], expected?: string[]): HeldOutReport | null {
  const total = completeCaseScore(byCase, expected)
  if (total === null) return null
  return {
    score: Math.round(total * 100) / 100,
    scoreStd: meanStd(byCase.filter((c) => c.score !== null).map((c) => c.score as number)).std,
    cases: byCase.map((c) => ({
      caseId: c.caseId,
      score: c.score ?? 0,
      costUsd: c.costUsd ?? null,
      durationMs: c.durationMs ?? null,
      runs: c.runs ?? (c.sessionId ? [{ score: c.score ?? 0, costUsd: c.costUsd ?? null, durationMs: c.durationMs ?? null, sessionId: c.sessionId, tracePath: c.tracePath }] : []),
    })),
  }
}

/** 构造一条 BenchmarkEvaluation（为 baseline 或被接受候选）。 */
function buildEvaluation(
  benchmark: BenchmarkConfig,
  agentVersion: number,
  byCase: CaseEval[],
  time: string,
  judge?: JudgeIdentity | null,
  heldOutByCase?: CaseEval[] | null,
  maxTurns?: number,
): BenchmarkEvaluation {
  const total = averageCaseScore(byCase) ?? 0
  return {
    time,
    agentVersion,
    // 写入时冻结基准来源：后续配置变化不回填，影子对比据此判断两侧是否同一份基准。
    // 同时冻结案例素材、评判实现与运行配置，否则新记录也只能判为不可比。
    definition: freezeEvaluationDefinition(benchmark, time, { judge: judge ?? null, maxTurns }),
    score: Math.round(total * 100) / 100,
    costUsd: byCase.some((c) => c.costUsd != null) ? byCase.filter((c) => c.costUsd != null).reduce((s, c) => s + (c.costUsd as number), 0) : null,
    durationMs: byCase.some((c) => c.durationMs != null) ? byCase.filter((c) => c.durationMs != null).reduce((s, c) => s + (c.durationMs as number), 0) : null,
    runtime: benchmark.runtime,
    judge: judge ?? null,
    // 方差报告：跨 Case 分数的总体标准差（n<2 → null）
    scoreStd: meanStd(byCase.filter((c) => c.score !== null).map((c) => c.score as number)).std,
    heldOut: heldOutByCase ? toHeldOutReport(heldOutByCase, benchmark.heldOutCases) : null,
    cases: byCase.map((c) => ({
      caseId: c.caseId,
      score: c.score ?? 0,
      costUsd: c.costUsd ?? null,
      durationMs: c.durationMs ?? null,
      runs: c.runs ?? (c.sessionId ? [{ score: c.score ?? 0, costUsd: c.costUsd ?? null, durationMs: c.durationMs ?? null, sessionId: c.sessionId, tracePath: c.tracePath }] : []),
    })),
  }
}

/**
 * 运行一次优化闭环。
 *
 * @returns baseline + 每轮候选的接受/回滚决策。
 */
export async function selfEvolve(input: EvolveInput): Promise<EvolveOutput> {
  const baselineVersion = input.state.version()

  // 1) Baseline
  const baselineByCase = await input.evaluate(undefined, input.benchmark)
  const baselineScore = completeCaseScore(baselineByCase, input.benchmark.cases)
  if (baselineScore === null) throw new Error('训练集基线评测不完整，不能生成候选')
  // held-out baseline 同时用于记录与候选门禁，避免同一轮重复消耗评测预算。
  const heldOutBaseline = input.evaluateHeldOut ? await input.evaluateHeldOut(undefined, input.benchmark) : null
  // 每次实际完成的基线都是独立观测，即使被测版本相同也保留。
  const baselineEvaluation = buildEvaluation(input.benchmark, baselineVersion, baselineByCase, new Date().toISOString(), input.judge, heldOutBaseline, input.maxTurns)
  appendEvaluation(input.benchmark.id, baselineEvaluation)

  // 2) 迭代候选
  const rounds: SelfEvolveRoundResult[] = []
  let currentVersion = baselineVersion
  let currentScore = baselineScore
  const baselineHeldOutScore = heldOutBaseline ? completeCaseScore(heldOutBaseline, input.benchmark.heldOutCases) : null

  for (let round = 1; round <= input.maxRounds; round++) {
    const deficit = baselineByCase.map((c) => ({ caseId: c.caseId, score: c.score }))
    const change = await input.propose({ benchmark: input.benchmark, deficit, round })
    if (!change) break

    // 快照 + 应用候选
    await input.state.snapshot(`round-${round}`)
    await input.state.apply(change)
    const candidateVersion = input.state.version()

    let accepted = false
    let rolledBack = false
    let candidateScore = currentScore
    let reason = ''
    let candidateEvaluation: BenchmarkEvaluation | undefined

    try {
      const candidateByCase = await input.evaluate(change.afterState, input.benchmark)
      const candidateTotal = completeCaseScore(candidateByCase, input.benchmark.cases)
      candidateScore = candidateTotal ?? 0
      if (candidateTotal !== null) {
        // 与 Reference 同一份冻结基准：这是影子对比唯一来源可信的场景，因此在这里落地报告。
        candidateEvaluation = buildEvaluation(input.benchmark, candidateVersion, candidateByCase, new Date().toISOString(), input.judge, null, input.maxTurns)
      }
      if (candidateTotal === null) {
        reason = '候选评测无效（无有效分数）'
        // 回滚到 Reference
        await input.state.restore()
        rolledBack = true
      } else if (candidateTotal > currentScore) {
        // held-out 是推广门禁而非仅报告：训练分上涨但独立案例下降则回滚。
        const heldOutCandidate = input.evaluateHeldOut ? await input.evaluateHeldOut(change.afterState, input.benchmark) : null
        const heldOutScore = heldOutCandidate ? completeCaseScore(heldOutCandidate, input.benchmark.heldOutCases) : null
        const heldOutThreshold = (baselineHeldOutScore ?? -Infinity) - (input.heldOutMaxRegression ?? 0)
        if (input.evaluateHeldOut && (baselineHeldOutScore === null || heldOutScore === null)) {
          reason = '拒绝：held-out 基线或候选评测不完整'
          await input.state.restore()
          rolledBack = true
        } else if (heldOutScore !== null && heldOutScore < heldOutThreshold) {
          accepted = false
          reason = `拒绝：held-out ${heldOutScore.toFixed(2)} 低于门槛 ${heldOutThreshold.toFixed(2)}`
          await input.state.restore()
          rolledBack = true
        } else {
          // 用与对比报告同一条记录落盘，避免报告与 scoreboard 出现两份不同回执。
          const acceptedEvaluation = { ...candidateEvaluation!, heldOut: heldOutCandidate ? toHeldOutReport(heldOutCandidate, input.benchmark.heldOutCases) : null }
          candidateEvaluation = acceptedEvaluation
          appendEvaluation(input.benchmark.id, acceptedEvaluation)
          accepted = true
          reason = `接受：${candidateTotal.toFixed(2)} > Reference ${currentScore.toFixed(2)}；held-out 门禁通过`
          currentScore = candidateTotal
          currentVersion = candidateVersion
        }
      } else {
        reason = `拒绝：${candidateTotal.toFixed(2)} 未严格高于 Reference ${currentScore.toFixed(2)}`
        await input.state.restore()
        rolledBack = true
      }
    } catch (error) {
      reason = `候选评测异常：${String(error instanceof Error ? error.message : error)}`
      await input.state.restore()
      rolledBack = true
    }

    const comparison = candidateEvaluation
      ? compareRecordedEvaluations({
          baseline: baselineEvaluation,
          candidate: candidateEvaluation,
          expectedCaseIds: input.benchmark.cases,
          ...(input.comparisonDeltaThreshold === undefined ? {} : { deltaThreshold: input.comparisonDeltaThreshold }),
          ...(input.maxCostIncreaseRatio === undefined ? {} : { maxCostIncreaseRatio: input.maxCostIncreaseRatio }),
          ...(input.maxLatencyIncreaseRatio === undefined ? {} : { maxLatencyIncreaseRatio: input.maxLatencyIncreaseRatio }),
        })
      : undefined
    rounds.push({
      agentVersion: candidateVersion,
      change,
      score: Math.round(candidateScore * 100) / 100,
      accepted,
      reason,
      rolledBack,
      ...(comparison ? { comparison, comparisonSummary: describeShadowComparison(comparison) } : {}),
    })
  }

  return {
    baseline: { agentVersion: baselineVersion, totalScore: Math.round(baselineScore * 100) / 100, byCase: baselineByCase },
    rounds,
    finalAcceptedVersion: currentVersion,
    finalScore: Math.round(currentScore * 100) / 100,
  }
}
