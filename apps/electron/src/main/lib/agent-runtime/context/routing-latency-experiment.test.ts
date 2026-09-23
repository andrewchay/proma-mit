import { describe, expect, test } from 'bun:test'
import { runRoutingLatencyExperiment, summarizeRoutingQuality } from './routing-latency-experiment'
import { buildSelectionCatalog, TOOL_SELECTION_CASES } from './tool-selection-fixture'

const catalog = buildSelectionCatalog()

const providers = [
  {
    id: 'p-fast',
    provider: 'zhipu' as const,
    modelId: 'glm-5.3-flash',
    pricing: { currency: 'USD' as const, source: 'fixture', inputPerMTokens: 1, outputPerMTokens: 4 },
  },
  {
    id: 'p-slow',
    provider: 'deepseek' as const,
    modelId: 'deepseek-v4-flash',
    pricing: { currency: 'USD' as const, source: 'fixture', inputPerMTokens: 2, outputPerMTokens: 8 },
  },
]

function makeDelegate(correctProvider: string, latencyProvider: string): Parameters<typeof runRoutingLatencyExperiment>[0]['delegate'] {
  return async ({ providerId, caseId }) => {
    const expected = TOOL_SELECTION_CASES.find((testCase) => testCase.id === caseId)!.expectedToolId
    return {
      text: `{"selectedId":"${expected}","confidence":"high"}`,
      inputTokens: 1000,
      outputTokens: 20,
      cacheStatus: 'miss',
      ...(providerId === latencyProvider ? { } : {}),
    }
  }
}

describe('M6-05 routing latency experiment', () => {
  test('measures per-provider accuracy, latency, and cost from real-style runs', async () => {
    let tick = 0
    const runs = await runRoutingLatencyExperiment({
      cases: TOOL_SELECTION_CASES.slice(0, 2),
      providers,
      runsPerCase: 2,
      catalog,
      now: () => (tick += 500),
      delegate: makeDelegate('p-fast', 'p-slow'),
    })

    expect(runs).toHaveLength(8)
    const report = summarizeRoutingQuality(runs)
    expect(report.benchmarkId).toBe('routing-latency-benchmark')
    expect(report.autoEnabled).toBe(false)
    expect(report.providers).toHaveLength(2)
    // 两个 provider 全部答对：路由选择的质量与最优候选持平
    expect(report.qualityNonInferior).toBe(true)
    expect(report.routedAccuracy).toBe(report.bestAccuracy)
    // 路由按估计成本选了更便宜的 p-fast
    expect(report.routedProviderId).toBe('p-fast')
  })

  test('quality non-inferiority fails when the routed provider is less accurate', async () => {
    const runs = await runRoutingLatencyExperiment({
      cases: TOOL_SELECTION_CASES.slice(0, 1),
      providers,
      runsPerCase: 1,
      catalog,
      delegate: async ({ providerId, caseId }) => {
        const expected = TOOL_SELECTION_CASES.find((testCase) => testCase.id === caseId)!.expectedToolId
        // p-fast 更便宜但答错：路由质量必须被判定为劣化
        const correct = providerId !== 'p-fast'
        return {
          text: `{"selectedId":"${correct ? expected : 'builtin:wrong-tool'}","confidence":"high"}`,
          inputTokens: 1000,
          outputTokens: 20,
          cacheStatus: 'miss',
        }
      },
    })

    const report = summarizeRoutingQuality(runs)
    expect(report.routedProviderId).toBe('p-fast')
    expect(report.qualityNonInferior).toBe(false)
  })

  test('failed runs are excluded from accuracy but recorded', async () => {
    const runs = await runRoutingLatencyExperiment({
      cases: TOOL_SELECTION_CASES.slice(0, 1),
      providers: providers.slice(0, 1),
      runsPerCase: 1,
      catalog,
      delegate: async () => { throw new Error('network down') },
    })

    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.protocolError).toContain('network down')
    const report = summarizeRoutingQuality(runs)
    expect(report.providers[0]!.accuracy).toBe(0)
    expect(report.qualityNonInferior).toBe(false)
  })
})
