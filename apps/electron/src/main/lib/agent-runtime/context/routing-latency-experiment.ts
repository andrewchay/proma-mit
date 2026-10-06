/**
 * M6-05 真实流量延迟/质量实验。
 *
 * 同一组选择用例在多个 provider 上真实调用，测量准确率、延迟与真实 usage，
 * 再把测量结果喂给 M6-02 成本模型与 M6-04 路由，验证路由选择的质量不劣于候选均值。
 */
import type { ModelPricing, ProviderType } from '@gravitas/shared'
import { estimateRequestCost } from '@gravitas/shared'
import type { ToolSelectionCase } from './tool-selection-fixture'
import { buildToolSelectionPrompt, parseToolSelection, TOOL_SELECTION_SYSTEM_PROMPT, type ToolSelectionDelegateResult } from './tool-selection-experiment'

export interface RoutingLatencyProvider {
  id: string
  provider: ProviderType
  modelId: string
  pricing: ModelPricing
}

export type RoutingLatencyDelegate = (input: {
  providerId: string
  caseId: string
  task: string
  systemPrompt: string
}) => Promise<ToolSelectionDelegateResult>

export interface RoutingLatencyRun {
  scenarioId: string
  providerId: string
  provider: ProviderType
  modelId: string
  run: number
  status: 'ok' | 'failed'
  correct: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  latencyMs: number
  estimatedTotalCost: number
  estimateAssumptions: string[]
  protocolError?: string
}

export interface RoutingQualityReport {
  version: 1
  benchmarkId: 'routing-latency-benchmark'
  providers: Array<{
    providerId: string
    provider: ProviderType
    modelId: string
    runs: number
    okRuns: number
    accuracy: number
    avgLatencyMs: number
    totalEstimatedCost: number
  }>
  /** 路由选中的 provider 的准确率，必须不低于所有候选的最好准确率（质量不劣化）。 */
  routedProviderId: string | null
  routedAccuracy: number
  bestAccuracy: number
  qualityNonInferior: boolean
  autoEnabled: false
}

export async function runRoutingLatencyExperiment(input: {
  cases: readonly ToolSelectionCase[]
  providers: readonly RoutingLatencyProvider[]
  runsPerCase: number
  catalog: import('@gravitas/shared').CapabilityCatalog
  delegate: RoutingLatencyDelegate
  now?: () => number
  onRun?: (run: RoutingLatencyRun) => void
  alreadyCompleted?: ReadonlySet<string>
  /** 每次调用之间的间隔毫秒数，避免触发渠道 QPS 限制。 */
  pacingMs?: number
}): Promise<RoutingLatencyRun[]> {
  const runs: RoutingLatencyRun[] = []
  const now = input.now ?? Date.now
  const pacingMs = input.pacingMs ?? 0
  const pace = async (): Promise<void> => {
    if (pacingMs > 0) await new Promise((resolve) => setTimeout(resolve, pacingMs))
  }
  for (const testCase of input.cases) {
    for (const provider of input.providers) {
      for (let run = 1; run <= input.runsPerCase; run++) {
        const key = `${testCase.id}:${provider.id}:${run}`
        if (input.alreadyCompleted?.has(key)) continue
        await pace()
        const startedAt = now()
        let record: RoutingLatencyRun
        try {
          const result: ToolSelectionDelegateResult = await input.delegate({
            providerId: provider.id,
            caseId: testCase.id,
            task: buildToolSelectionPrompt({ testCase, catalog: input.catalog, variant: 'summary_on_demand' }),
            systemPrompt: TOOL_SELECTION_SYSTEM_PROMPT,
          })
          const parsed = parseToolSelection(result.text)
          const cost = estimateRequestCost({
            provider: provider.provider,
            modelId: provider.modelId,
            // delegate 聚合口径：inputTokens 已包含 cache-read 部分，无法拆分；
            // 因此按「全部 tokens 走 input 单价」的保守上界估算，不假装拆出折扣。
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: 0,
          }, provider.pricing)
          record = {
            scenarioId: testCase.id,
            providerId: provider.id,
            provider: provider.provider,
            modelId: provider.modelId,
            run,
            status: parsed.protocolError ? 'failed' : 'ok',
            correct: parsed.selectedId === testCase.expectedToolId,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheStatus === 'hit' ? result.inputTokens : 0,
            latencyMs: Math.max(0, now() - startedAt),
            estimatedTotalCost: cost.total,
            estimateAssumptions: cost.assumptions,
            ...(parsed.protocolError ? { protocolError: parsed.protocolError } : {}),
          }
        } catch (error) {
          record = {
            scenarioId: testCase.id,
            providerId: provider.id,
            provider: provider.provider,
            modelId: provider.modelId,
            run,
            status: 'failed',
            correct: false,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            latencyMs: Math.max(0, now() - startedAt),
            estimatedTotalCost: 0,
            estimateAssumptions: [],
            protocolError: error instanceof Error ? error.message : String(error),
          }
        }
        runs.push(record)
        input.onRun?.(record)
      }
    }
  }
  return runs
}

export function summarizeRoutingQuality(runs: readonly RoutingLatencyRun[]): RoutingQualityReport {
  const providerIds = [...new Set(runs.map((run) => run.providerId))]
  const providers = providerIds.map((providerId) => {
    const providerRuns = runs.filter((run) => run.providerId === providerId)
    const okRuns = providerRuns.filter((run) => run.status === 'ok')
    const sample = providerRuns[0]
    return {
      providerId,
      provider: sample?.provider ?? ('custom' as ProviderType),
      modelId: sample?.modelId ?? '',
      runs: providerRuns.length,
      okRuns: okRuns.length,
      accuracy: okRuns.length === 0 ? 0 : okRuns.filter((run) => run.correct).length / okRuns.length,
      avgLatencyMs: okRuns.length === 0 ? 0 : Math.round(okRuns.reduce((total, run) => total + run.latencyMs, 0) / okRuns.length),
      totalEstimatedCost: okRuns.reduce((total, run) => total + run.estimatedTotalCost, 0),
    }
  })

  // 路由选择：成本模型下估计总成本最低的 provider（与 M6-04 的选择规则一致）
  const routed = [...providers].sort((a, b) => a.totalEstimatedCost - b.totalEstimatedCost)[0]
  const bestAccuracy = providers.length === 0 ? 0 : Math.max(...providers.map((provider) => provider.accuracy))
  const routedAccuracy = routed?.accuracy ?? 0
  // 空数据上的非劣性是空洞的：路由候选没有任何成功运行时不得判定为非劣。
  const routedHasEvidence = (routed?.okRuns ?? 0) > 0
  return {
    version: 1,
    benchmarkId: 'routing-latency-benchmark',
    providers,
    routedProviderId: routed?.providerId ?? null,
    routedAccuracy,
    bestAccuracy,
    qualityNonInferior: routedHasEvidence && routedAccuracy >= bestAccuracy,
    autoEnabled: false,
  }
}
