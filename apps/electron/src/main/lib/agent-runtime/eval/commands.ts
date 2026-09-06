/**
 * 评测/自演化上层的命令编排（CLI / IPC 触点的纯逻辑入口）。
 *
 * 与具体渠道/凭据/运行时解耦：调用方注入 `SubAgentDelegate`（生产环境接现有 runSubAgent /
 * ProviderAgnosticAgentAdapter，测试接 mock），本模块把它们与 benchmark-store / evaluator /
 * self-evolver 编排成「跑 Baseline」「跑 Improve」两个可直接输出的命令。
 */

import { appendEvaluation, readBenchmark, readScoreboard } from './benchmark-store'
import { evaluateCaseRun, meanStd, type EvalProgressCallback, type ScoreDelegate, type SubAgentDelegate } from './evaluator'
import { selfEvolve, type ProposeChange, type StateGuard } from './self-evolver'
import type { BenchmarkConfig, BenchmarkEvaluation, HeldOutReport, JudgeIdentity, SelfEvolveChange } from './types'

export interface RunBaselineOptions {
  benchmark: BenchmarkConfig
  delegate: SubAgentDelegate
  /** 可选：更准的 LLM 打分回调 */
  scoreDelegate?: ScoreDelegate
  /** 本次评判者身份（评估器独立性审计），写入 evaluation */
  judge?: JudgeIdentity | null
  /** 是否评测 held-out Case 集（迁移测试；不参与任何优化，仅落盘对照） */
  includeHeldOut?: boolean
  /** 当前被测 Agent 状态版本（快照层维护） */
  agentVersion: number
  abortSignal?: AbortSignal
  /** 每个 Case 的运行状态，用于 UI 显示进度。 */
  onProgress?: EvalProgressCallback
}

export interface BaselineSummary {
  benchmarkId: string
  agentVersion: number
  score: number
  /** held-out 迁移分（仅 includeHeldOut 时存在） */
  heldOutScore?: number
  byCase: Array<{ caseId: string; score: number }>
  evaluationsBefore: number
}

/**
 * 对单个 Case 跑 runsPerCase 次评测并取平均（消除单次随机性）。
 * 返回 case 平均分 + 每个 run 的明细。
 */
async function evaluateCaseAcrossRuns(
  benchmark: BenchmarkConfig,
  caseId: string,
  agentVersion: number,
  delegate: SubAgentDelegate,
  opts: { scoreDelegate?: ScoreDelegate; abortSignal?: AbortSignal; systemPrompt?: string } = {},
): Promise<{ score: number; runs: Array<{ score: number; run: number; sessionId?: string; tracePath?: string }> }> {
  const runsCount = Math.max(1, benchmark.runsPerCase ?? 1)
  const allRuns = []
  for (let i = 0; i < runsCount; i++) {
    const run = await evaluateCaseRun(benchmark, caseId, i + 1, agentVersion, delegate, {
      scoreDelegate: opts.scoreDelegate,
      abortSignal: opts.abortSignal,
      systemPrompt: opts.systemPrompt,
    })
    allRuns.push(run)
  }
  const scored = allRuns.filter((r) => r.status === 'ok')
  const runs = allRuns.map((r) => ({ score: r.status === 'ok' ? r.score : 0, run: r.run, sessionId: r.sessionId, tracePath: r.tracePath }))
  const caseScore = scored.length === 0
    ? 0
    : scored.reduce((s, r) => s + r.score, 0) / scored.length
  return { score: Math.round(caseScore * 100) / 100, runs }
}

/** 跑一次 Baseline：对 benchmark 内所有 case 各跑 runsPerCase 次，取平均并写入 scoreboard。 */
export async function runBaseline(opts: RunBaselineOptions): Promise<BaselineSummary> {
  const before = readScoreboard(opts.benchmark.id).evaluations.length
  const byCase: Array<{ caseId: string; score: number; runs: Array<{ score: number; run: number; sessionId?: string; tracePath?: string }> }> = []
  for (const [index, caseId] of opts.benchmark.cases.entries()) {
    opts.onProgress?.({
      benchmarkId: opts.benchmark.id,
      caseId,
      phase: 'case_start',
      completedCases: index,
      totalCases: opts.benchmark.cases.length,
    })
    const result = await evaluateCaseAcrossRuns(
      opts.benchmark,
      caseId,
      opts.agentVersion,
      opts.delegate,
      { scoreDelegate: opts.scoreDelegate, abortSignal: opts.abortSignal },
    )
    byCase.push({ caseId, ...result })
    opts.onProgress?.({
      benchmarkId: opts.benchmark.id,
      caseId,
      phase: 'case_complete',
      completedCases: index + 1,
      totalCases: opts.benchmark.cases.length,
      score: result.score,
    })
  }
  const total = byCase.length === 0
    ? 0
    : byCase.reduce((s, c) => s + c.score, 0) / byCase.length
  // held-out 迁移评测（仅显式启用；不参与优化，只落盘对照）
  let heldOut: HeldOutReport | null = null
  if (opts.includeHeldOut && opts.benchmark.heldOutCases?.length) {
    const heldOutByCase: typeof byCase = []
    for (const caseId of opts.benchmark.heldOutCases) {
      const result = await evaluateCaseAcrossRuns(
        opts.benchmark,
        caseId,
        opts.agentVersion,
        opts.delegate,
        { scoreDelegate: opts.scoreDelegate, abortSignal: opts.abortSignal },
      )
      heldOutByCase.push({ caseId, ...result })
    }
    heldOut = {
      score: Math.round((heldOutByCase.reduce((s, c) => s + c.score, 0) / heldOutByCase.length) * 100) / 100,
      scoreStd: meanStd(heldOutByCase.map((c) => c.score)).std,
      cases: heldOutByCase.map((c) => ({
        caseId: c.caseId,
        score: c.score,
        scoreStd: meanStd(c.runs.map((r) => r.score)).std,
        runs: c.runs.map((r) => ({ score: r.score, sessionId: r.sessionId ?? '', tracePath: r.tracePath })),
      })),
    }
  }
  const evaluation: BenchmarkEvaluation = {
    time: new Date().toISOString(),
    agentVersion: opts.agentVersion,
    score: Math.round(total * 100) / 100,
    // 方差报告：跨 Case 分数的总体标准差（n<2 → null）
    scoreStd: meanStd(byCase.map((c) => c.score)).std,
    runtime: opts.benchmark.runtime,
    judge: opts.judge ?? null,
    heldOut,
    cases: byCase.map((c) => ({
      caseId: c.caseId,
      score: c.score,
      // 方差报告：多次 run 分数的总体标准差（n<2 → null）
      scoreStd: meanStd(c.runs.map((r) => r.score)).std,
      runs: c.runs.map((r) => ({ score: r.score, sessionId: r.sessionId ?? '', tracePath: r.tracePath })),
    })),
  }
  appendEvaluation(opts.benchmark.id, evaluation)
  return {
    benchmarkId: opts.benchmark.id,
    agentVersion: opts.agentVersion,
    score: evaluation.score,
    heldOutScore: heldOut?.score,
    byCase: byCase.map((c) => ({ caseId: c.caseId, score: c.score })),
    evaluationsBefore: before,
  }
}

export interface RunImproveOptions {
  benchmark: BenchmarkConfig
  delegate: SubAgentDelegate
  scoreDelegate?: ScoreDelegate
  /** 本次评判者身份（评估器独立性审计），写入每条 evaluation */
  judge?: JudgeIdentity | null
  /** 是否在 baseline 与被接受候选上评测 held-out Case 集（迁移测试，检测过拟合） */
  includeHeldOut?: boolean
  /** 候选生成器（默认从 scoreboard 最新成绩的失分 Case 生成，见 defaultPropose） */
  propose?: ProposeChange
  state: StateGuard
  maxRounds: number
  abortSignal?: AbortSignal
  /** 每接受一个候选时回调其 afterState（供调用方捕获最佳改进，用于“采纳写回”） */
  onAcceptedCandidate?: (candidate: SelfEvolveChange) => void
}

export interface ImproveSummary {
  baselineScore: number
  finalScore: number
  acceptedRounds: number
  totalRounds: number
  finalVersion: number
  /** 评分最高的被接受候选的 prompt（供 UI「审查并采纳」展示；无则缺省） */
  bestAcceptedPrompt?: string
}

/** 跑一次 Improve 闭环。 */
export async function runImprove(opts: RunImproveOptions): Promise<ImproveSummary> {
  // Baseline 由 selfEvolver 内部完成
  // 构造指定 Case 集的评测函数：train 集驱动优化；held-out 集仅在对照启用时评测
  const makeEvaluator = (caseIds: string[]) => (def: unknown, benchmark: BenchmarkConfig) =>
    Promise.all(
      caseIds.map(async (caseId) => {
        const version = opts.state.version()
        // def 为候选（change.afterState）：若带 prompt 字段则作为系统提示覆盖
        const candidatePrompt =
          def && typeof def === 'object'
            ? (def as Record<string, unknown>).prompt as string | undefined
            : undefined
        const { score, runs } = await evaluateCaseAcrossRuns(
          benchmark,
          caseId,
          version,
          opts.delegate,
          { scoreDelegate: opts.scoreDelegate, abortSignal: opts.abortSignal, systemPrompt: candidatePrompt },
        )
        return {
          caseId,
          score: score >= 0 ? score : null,
          costUsd: null,
          durationMs: null,
          sessionId: runs[0]?.sessionId,
          tracePath: runs[0]?.tracePath,
        }
      }),
    )
  const delegateForEvolve = makeEvaluator(opts.benchmark.cases)
  const evaluateHeldOut = opts.includeHeldOut && opts.benchmark.heldOutCases?.length
    ? makeEvaluator(opts.benchmark.heldOutCases)
    : undefined

  const out = await selfEvolve({
    benchmark: opts.benchmark,
    maxRounds: opts.maxRounds,
    propose: opts.propose ?? (async () => null),
    evaluate: delegateForEvolve,
    state: opts.state,
    judge: opts.judge,
    evaluateHeldOut,
  })

  // 把每个被接受候选的 afterState 回调出去（供“采纳写回”捕获最佳改进）
  let bestPrompt: string | undefined
  let bestScore = -Infinity
  if (opts.onAcceptedCandidate) {
    for (const round of out.rounds) {
      if (round.accepted && round.change?.afterState != null) {
        try {
          opts.onAcceptedCandidate(round.change)
        } catch (error) {
          console.error('[Eval] onAcceptedCandidate 回调失败:', error)
        }
      }
    }
  }
  // 汇总评分最高的被接受候选 prompt（供 UI 审查后显式采纳）
  for (const round of out.rounds) {
    if (round.accepted && round.score > bestScore) {
      bestScore = round.score
      const p = extractAfterStatePrompt(round.change?.afterState)
      if (p) bestPrompt = p
    }
  }

  return {
    baselineScore: out.baseline.totalScore,
    finalScore: out.finalScore,
    acceptedRounds: out.rounds.filter((r) => r.accepted).length,
    totalRounds: out.rounds.length,
    finalVersion: out.finalAcceptedVersion,
    bestAcceptedPrompt: bestPrompt,
  }
}

/** 从候选 afterState 提取 prompt 字符串（支持 { prompt } 或直接字符串）。 */
function extractAfterStatePrompt(afterState: unknown): string | undefined {
  if (typeof afterState === 'string') return afterState.trim()
  if (afterState && typeof afterState === 'object') {
    const p = (afterState as Record<string, unknown>).prompt
    if (typeof p === 'string' && p.trim()) return p.trim()
  }
  return undefined
}

/**
 * 一个保守的默认候选生成器：仅当 scoreboard 最近一次成绩缺失或需要时才产出「无实质风险」的候选。
 * 生产环境的真正候选应由 LLM/策略驱动；这里默认不自动改，避免无依据地改造内置 Agent 定义。
 */
export const conservativePropose: ProposeChange = async () => null

/** 从 benchmark 缺失总分的失分 Case 里构造一个最小候选（供需要确定性候选的调用方复用）。 */
export function buildSimpleCandidate(benchmark: BenchmarkConfig, afterState: unknown): SelfEvolveChange {
  return {
    description: `针对 benchmark '${benchmark.id}' 生成的候选`,
    target: benchmark.targetAgentId,
    afterState,
  }
}

/** 便捷：按 id 读 benchmark；不存在抛错。 */
export function requireBenchmark(benchmarkId: string): BenchmarkConfig {
  const b = readBenchmark(benchmarkId)
  if (!b) throw new Error(`Benchmark 不存在: ${benchmarkId}`)
  return b
}
