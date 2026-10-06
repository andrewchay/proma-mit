import { describe, expect, test } from 'bun:test'
import type { ContextItem } from '@gravitas/shared'
import { prepareTccExperimentPrompt, runTccExperiment, type TccExperimentFixture } from './tcc-experiment-runner'

const item = (id: string, content: string): ContextItem => ({
  id, kind: 'file_fact', version: 1, createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
  content, tags: ['audit'], visibility: 'parent', mutability: 'append_only', confidence: 'high',
  source: { kind: 'file_locator', id, sessionId: 'm3' }, evidence: [{ kind: 'file_locator', sourceId: id, verified: true }],
})

const fixture: TccExperimentFixture = {
  version: 1, benchmarkId: 'typed-context-compiler', cases: [{
    id: 'CASE-001', task: '引用审计事实。', brief: '请审计。', requiredItemIds: ['fact'], forbiddenItemIds: ['secret'],
    items: [item('fact', '审计事实'), { ...item('secret', '私密内容'), visibility: 'private' }],
    projectionRequest: { task: 'audit', sessionId: 'm3', purpose: 'evaluation', targetAgentId: 'explorer', targetModel: { provider: 'zhipu', modelId: 'glm-5.3-flash' }, maxInputTokens: 500, policy: { allowUnverified: false, includeRawEvidence: false, includeSummaries: true, includeFullContent: true } },
  }],
}

const valid = JSON.stringify({ protocolVersion: 1, status: 'completed', summary: 'ok', claims: [{ statement: '审计事实', confidence: 'high', verified: true, evidence: [{ kind: 'file_locator', sourceId: 'fact', verified: true }] }], artifacts: [], unverified: [], recommendedNextSteps: [] })

describe('TCC experiment runner', () => {
  test('uses real projector for typed variant while full and brief keep distinct baselines', () => {
    expect(prepareTccExperimentPrompt(fixture.cases[0]!, 'full_context').selectedItemIds).toEqual(['fact', 'secret'])
    expect(prepareTccExperimentPrompt(fixture.cases[0]!, 'brief').selectedItemIds).toEqual([])
    expect(prepareTccExperimentPrompt(fixture.cases[0]!, 'tcc_projection').selectedItemIds).toEqual(['fact'])
  })

  test('skips already completed runs so a resumed evaluation never pays twice', async () => {
    const calls: string[] = []
    const alreadyCompleted = new Set(['CASE-001:full_context:1', 'CASE-001:brief:1'])
    const result = await runTccExperiment({ fixture, provider: 'zhipu', modelId: 'glm-5.3-flash', implementationVersion: 'test', runsPerCase: 1, alreadyCompleted,
      delegate: async ({ variant }) => { calls.push(variant); return { text: valid, inputTokens: 10, outputTokens: 4 } },
    })

    expect(calls).toEqual(['tcc_projection'])
    expect(result.runs.map((run) => `${run.caseId}:${run.variant}:${run.run}`)).toEqual(['CASE-001:tcc_projection:1'])
  })

  test('records protocol failures fail-closed and preserves runtime metrics', async () => {
    let tick = 0
    const result = await runTccExperiment({ fixture, provider: 'zhipu', modelId: 'glm-5.3-flash', implementationVersion: 'test', runsPerCase: 1,
      now: () => tick++ * 10,
      delegate: async ({ variant }) => ({ text: variant === 'brief' ? 'not-json' : valid, inputTokens: 10, outputTokens: 4, retryCount: 1 }),
    })
    expect(result.runs).toHaveLength(3)
    expect(result.runs.find((run) => run.variant === 'brief')?.status).toBe('failed')
    expect(result.runs.find((run) => run.variant === 'tcc_projection')).toMatchObject({ status: 'ok', verifiedClaims: 1, totalClaims: 1, cacheStatus: 'unknown', durationMs: 10 })
  })
})
