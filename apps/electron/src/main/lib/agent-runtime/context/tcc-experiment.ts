import type { ContextCacheStatus } from './context-metrics'

export const TCC_EXPERIMENT_VARIANTS = ['full_context', 'brief', 'tcc_projection'] as const
export type TccExperimentVariant = (typeof TCC_EXPERIMENT_VARIANTS)[number]

export interface TccExperimentCase {
  id: string
  task: string
  requiredItemIds: string[]
  forbiddenItemIds?: string[]
}

export interface TccExperimentRun {
  caseId: string
  variant: TccExperimentVariant
  run: number
  provider: string
  modelId: string
  implementationVersion: string
  status: 'ok' | 'failed' | 'skipped'
  score?: number
  inputTokens: number
  outputTokens: number
  cacheStatus: ContextCacheStatus
  durationMs: number
  retryCount: number
  selectedItemIds: string[]
  verifiedClaims: number
  totalClaims: number
  /** typed-v1 协议失败原因（分类信息，不含模型正文）。 */
  protocolError?: string
}

export interface TccExperimentScoreboard {
  version: 1
  benchmarkId: 'typed-context-compiler'
  cases: TccExperimentCase[]
  runs: TccExperimentRun[]
}

export interface TccExperimentVariantSummary {
  variant: TccExperimentVariant
  successRate: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  retryCount: number
  evidenceCoverage: number | null
  falseOmissionRate: number
  falseInclusionRate: number
  unknownCacheRuns: number
}

export interface TccExperimentGate {
  passed: boolean
  reasons: string[]
  summaries: TccExperimentVariantSummary[]
}

/**
 * 汇总 TCC 对照实验。`unknown` cache 明确单列，且不从 input token 中扣减，
 * 因而成本估算保持保守，不会把未知 provider 行为伪装成 cache hit。
 */
export function summarizeTccExperiment(scoreboard: TccExperimentScoreboard): TccExperimentVariantSummary[] {
  return TCC_EXPERIMENT_VARIANTS.map((variant) => {
    const runs = scoreboard.runs.filter((run) => run.variant === variant)
    const successful = runs.filter((run) => run.status === 'ok')
    const required = new Map(scoreboard.cases.map((item) => [item.id, new Set(item.requiredItemIds)]))
    const forbidden = new Map(scoreboard.cases.map((item) => [item.id, new Set(item.forbiddenItemIds ?? [])]))
    const totalRequired = successful.reduce((total, run) => total + (required.get(run.caseId)?.size ?? 0), 0)
    const omitted = successful.reduce((total, run) => total + missingRequired(run, required.get(run.caseId) ?? new Set()), 0)
    const included = successful.reduce((total, run) => total + unexpectedIncluded(run, forbidden.get(run.caseId) ?? new Set()), 0)
    const totalForbidden = successful.reduce((total, run) => total + (forbidden.get(run.caseId)?.size ?? 0), 0)
    const totalClaims = successful.reduce((total, run) => total + run.totalClaims, 0)
    const verifiedClaims = successful.reduce((total, run) => total + run.verifiedClaims, 0)
    return {
      variant,
      successRate: runs.length === 0 ? 0 : successful.length / runs.length,
      inputTokens: successful.reduce((total, run) => total + run.inputTokens, 0),
      outputTokens: successful.reduce((total, run) => total + run.outputTokens, 0),
      durationMs: successful.reduce((total, run) => total + run.durationMs, 0),
      retryCount: successful.reduce((total, run) => total + run.retryCount, 0),
      evidenceCoverage: totalClaims === 0 ? null : verifiedClaims / totalClaims,
      falseOmissionRate: totalRequired === 0 ? 0 : omitted / totalRequired,
      falseInclusionRate: totalForbidden === 0 ? 0 : included / totalForbidden,
      unknownCacheRuns: successful.filter((run) => run.cacheStatus === 'unknown').length,
    }
  })
}

/** M3 adoption gate：样本不完整、skip 或任一阈值不足都不得自动推广。 */
export function evaluateTccExperimentGate(scoreboard: TccExperimentScoreboard, minimumRunsPerCase = 3): TccExperimentGate {
  const reasons = validateCoverage(scoreboard, minimumRunsPerCase)
  const summaries = summarizeTccExperiment(scoreboard)
  const full = summaryFor(summaries, 'full_context')
  const tcc = summaryFor(summaries, 'tcc_projection')
  if (full && tcc) {
    if (tcc.successRate < full.successRate * 0.95) reasons.push('TCC success rate is below 95% of full-context baseline')
    if (tcc.evidenceCoverage === null || tcc.evidenceCoverage < 0.9) reasons.push('TCC evidence coverage is below 90%')
    if (tcc.falseOmissionRate > 0.05) reasons.push('TCC false omission rate exceeds 5%')
    const inputImproved = full.inputTokens > 0 && tcc.inputTokens <= full.inputTokens * 0.8
    const stabilityImproved = tcc.retryCount < full.retryCount || tcc.durationMs < full.durationMs
    if (!inputImproved && !stabilityImproved) reasons.push('TCC shows no input-token or stability improvement')
  }
  return { passed: reasons.length === 0, reasons, summaries }
}

function validateCoverage(scoreboard: TccExperimentScoreboard, minimumRunsPerCase: number): string[] {
  const reasons: string[] = []
  if (scoreboard.cases.length < 10) reasons.push('benchmark requires at least 10 fixed cases')
  for (const testCase of scoreboard.cases) {
    for (const variant of TCC_EXPERIMENT_VARIANTS) {
      const runs = scoreboard.runs.filter((run) => run.caseId === testCase.id && run.variant === variant)
      if (runs.length < minimumRunsPerCase) reasons.push(`${testCase.id}/${variant} has fewer than ${minimumRunsPerCase} runs`)
      if (runs.some((run) => run.status === 'skipped')) reasons.push(`${testCase.id}/${variant} includes skipped runs`)
      if (runs.some((run) => !run.provider || !run.modelId || !run.implementationVersion)) reasons.push(`${testCase.id}/${variant} lacks runtime identity`)
    }
  }
  return reasons
}

function summaryFor(summaries: TccExperimentVariantSummary[], variant: TccExperimentVariant): TccExperimentVariantSummary | undefined {
  return summaries.find((summary) => summary.variant === variant)
}

function missingRequired(run: TccExperimentRun, required: Set<string>): number {
  const selected = new Set(run.selectedItemIds)
  return [...required].filter((id) => !selected.has(id)).length
}

function unexpectedIncluded(run: TccExperimentRun, forbidden: Set<string>): number {
  const selected = new Set(run.selectedItemIds)
  return [...forbidden].filter((id) => selected.has(id)).length
}
