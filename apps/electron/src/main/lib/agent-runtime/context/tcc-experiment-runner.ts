import type { ContextItem, ContextProjectionRequest } from '@gravitas/shared'
import { parseSubtaskResult, TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT } from './subtask-result-parser'
import { prepareSubAgentProjectionFromItems } from './subagent-projection-adapter'
import type { ContextCacheStatus } from './context-metrics'
import type { TccExperimentCase, TccExperimentRun, TccExperimentScoreboard, TccExperimentVariant } from './tcc-experiment'

export interface TccExperimentFixtureCase extends TccExperimentCase {
  brief: string
  items: ContextItem[]
  projectionRequest: ContextProjectionRequest
}

export interface TccExperimentFixture {
  version: 1
  benchmarkId: 'typed-context-compiler'
  cases: TccExperimentFixtureCase[]
}

export interface TccExperimentModelResult {
  text: string
  inputTokens: number
  outputTokens: number
  cacheStatus?: ContextCacheStatus
  retryCount?: number
}

export type TccExperimentDelegate = (input: {
  caseId: string
  variant: TccExperimentVariant
  task: string
  systemPrompt: string
}) => Promise<TccExperimentModelResult>

export interface RunTccExperimentOptions {
  fixture: TccExperimentFixture
  provider: string
  modelId: string
  implementationVersion: string
  runsPerCase: number
  delegate: TccExperimentDelegate
  now?: () => number
}

/**
 * 在同一 case 上构造 full / brief / actual-projector 三种输入。模型调用由注入 delegate
 * 完成，以便生产路径在 Electron 主进程里安全使用 safeStorage 中的渠道凭据。
 */
export async function runTccExperiment(options: RunTccExperimentOptions): Promise<TccExperimentScoreboard> {
  const runs: TccExperimentRun[] = []
  const now = options.now ?? Date.now
  for (const testCase of options.fixture.cases) {
    for (const variant of ['full_context', 'brief', 'tcc_projection'] as const) {
      for (let run = 1; run <= options.runsPerCase; run++) {
        const startedAt = now()
        try {
          const prepared = prepareTccExperimentPrompt(testCase, variant)
          const result = await options.delegate({
            caseId: testCase.id,
            variant,
            task: prepared.task,
            systemPrompt: `${TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT}\n\n你只能依据提供的上下文回答；引用 evidence 的 sourceId 必须对应上下文 item id。`,
          })
          const parsed = parseSubtaskResult(result.text, `${testCase.id}:${variant}:${run}`)
          const claims = parsed.result.claims
          const verifiedClaims = claims.filter((claim) => claim.verified && claim.evidence.length > 0).length
          runs.push({
            caseId: testCase.id,
            variant,
            run,
            provider: options.provider,
            modelId: options.modelId,
            implementationVersion: options.implementationVersion,
            status: parsed.protocolError ? 'failed' : 'ok',
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheStatus: result.cacheStatus ?? 'unknown',
            durationMs: Math.max(0, now() - startedAt),
            retryCount: result.retryCount ?? 0,
            selectedItemIds: prepared.selectedItemIds,
            verifiedClaims,
            totalClaims: claims.length,
          })
        } catch {
          runs.push({
            caseId: testCase.id,
            variant,
            run,
            provider: options.provider,
            modelId: options.modelId,
            implementationVersion: options.implementationVersion,
            status: 'failed',
            inputTokens: 0,
            outputTokens: 0,
            cacheStatus: 'unknown',
            durationMs: Math.max(0, now() - startedAt),
            retryCount: 0,
            selectedItemIds: [],
            verifiedClaims: 0,
            totalClaims: 0,
          })
        }
      }
    }
  }
  return { version: 1, benchmarkId: 'typed-context-compiler', cases: options.fixture.cases, runs }
}

export function prepareTccExperimentPrompt(testCase: TccExperimentFixtureCase, variant: TccExperimentVariant): {
  task: string
  selectedItemIds: string[]
} {
  if (variant === 'brief') return { task: `${testCase.task}\n\n## Brief\n${testCase.brief}`, selectedItemIds: [] }
  if (variant === 'full_context') {
    return {
      task: `${testCase.task}\n\n## Full parent context\n${testCase.items.map((item) => `[ITEM id=${item.id}]\n${item.content}`).join('\n\n')}`,
      selectedItemIds: testCase.items.map((item) => item.id),
    }
  }
  // 评测必须走与生产完全相同的 spawn 边界，否则测得的不是真实投影行为。
  const preparation = prepareSubAgentProjectionFromItems({
    parentSessionId: testCase.projectionRequest.sessionId,
    enabled: true,
    subAgent: {
      agentName: testCase.projectionRequest.targetAgentId ?? 'explorer',
      task: testCase.task,
      context: { projection: testCase.projectionRequest, resultProtocol: 'typed-v1', readOnly: true },
    },
    items: testCase.items,
    sourceRevision: `m3:${testCase.id}`,
  })
  if (!preparation.projection) throw new Error(`TCC projection unavailable for ${testCase.id}`)
  return {
    task: `${testCase.task}${preparation.promptSuffix}`,
    selectedItemIds: preparation.projection.items.map((item) => item.itemId),
  }
}
