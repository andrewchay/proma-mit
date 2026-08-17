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

import { appendEvaluation, readScoreboard } from './benchmark-store'
import type { BenchmarkConfig, BenchmarkEvaluation, SelfEvolveChange, SelfEvolveRoundResult } from './types'

/** 评测单个 Case × run 的分数（含成本/耗时可选）。null=评测失败。 */
export interface CaseEval {
  caseId: string
  score: number | null
  costUsd?: number | null
  durationMs?: number | null
  sessionId?: string
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

/** 构造一条 BenchmarkEvaluation（为 baseline 或被接受候选）。 */
function buildEvaluation(
  benchmark: BenchmarkConfig,
  agentVersion: number,
  byCase: CaseEval[],
  time: string,
): BenchmarkEvaluation {
  const total = averageCaseScore(byCase) ?? 0
  return {
    time,
    agentVersion,
    score: Math.round(total * 100) / 100,
    costUsd: byCase.some((c) => c.costUsd != null) ? byCase.filter((c) => c.costUsd != null).reduce((s, c) => s + (c.costUsd as number), 0) : null,
    durationMs: byCase.some((c) => c.durationMs != null) ? byCase.filter((c) => c.durationMs != null).reduce((s, c) => s + (c.durationMs as number), 0) : null,
    runtime: benchmark.runtime,
    cases: byCase.map((c) => ({
      caseId: c.caseId,
      score: c.score ?? 0,
      costUsd: c.costUsd ?? null,
      durationMs: c.durationMs ?? null,
      runs: c.sessionId ? [{ score: c.score ?? 0, costUsd: c.costUsd ?? null, durationMs: c.durationMs ?? null, sessionId: c.sessionId, tracePath: c.tracePath }] : [],
    })),
  }
}

/**
 * 运行一次优化闭环。
 *
 * @returns baseline + 每轮候选的接受/回滚决策。
 */
export async function selfEvolve(input: EvolveInput): Promise<EvolveOutput> {
  const sc = readScoreboard(input.benchmark.id)
  const baselineVersion = input.state.version()

  // 1) Baseline
  const baselineByCase = await input.evaluate(undefined, input.benchmark)
  const baselineScore = averageCaseScore(baselineByCase) ?? 0
  // 记录 baseline 到 scoreboard（若无同版本记录）
  if (!sc.evaluations.some((e) => e.agentVersion === baselineVersion)) {
    appendEvaluation(input.benchmark.id, buildEvaluation(input.benchmark, baselineVersion, baselineByCase, new Date().toISOString()))
  }

  // 2) 迭代候选
  const rounds: SelfEvolveRoundResult[] = []
  let currentVersion = baselineVersion
  let currentScore = baselineScore

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

    try {
      const candidateByCase = await input.evaluate(change.afterState, input.benchmark)
      const candidateTotal = averageCaseScore(candidateByCase)
      candidateScore = candidateTotal ?? 0
      if (candidateTotal === null) {
        reason = '候选评测无效（无有效分数）'
        // 回滚到 Reference
        await input.state.restore()
        rolledBack = true
      } else if (candidateTotal > currentScore) {
        accepted = true
        appendEvaluation(input.benchmark.id, buildEvaluation(input.benchmark, candidateVersion, candidateByCase, new Date().toISOString()))
        reason = `接受：${candidateTotal.toFixed(2)} > Reference ${currentScore.toFixed(2)}`
        currentScore = candidateTotal
        currentVersion = candidateVersion
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

    rounds.push({
      agentVersion: candidateVersion,
      change,
      score: Math.round(candidateScore * 100) / 100,
      accepted,
      reason,
      rolledBack,
    })
  }

  return {
    baseline: { agentVersion: baselineVersion, totalScore: Math.round(baselineScore * 100) / 100, byCase: baselineByCase },
    rounds,
    finalAcceptedVersion: currentVersion,
    finalScore: Math.round(currentScore * 100) / 100,
  }
}
