import { describe, expect, mock, test } from 'bun:test'

const captured: Array<Record<string, unknown>> = []
let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | undefined

mock.module('../../adapters/provider-agnostic-agent-adapter', () => ({
  ProviderAgnosticAgentAdapter: class {
    async *query(input: Record<string, unknown>) {
      captured.push(input)
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n{"protocolVersion":1}\n```' }] } }
      if (usage) yield { type: 'result', usage }
    }
    dispose() {}
  },
}))

const { buildTccExperimentDelegate } = await import('./tcc-spawn-real-delegate')

const channel = { channelId: 'c1', provider: 'zhipu' as const, apiKey: 'secret-key', baseUrl: 'https://example.invalid', modelId: 'glm-5.3-flash' }
const isolation = { workspaceDir: '/tmp/tcc-eval-isolated' }

describe('TCC real evaluation delegate', () => {
  test('runs the evaluation with no tools and safe read-only permission mode', async () => {
    captured.length = 0
    usage = undefined
    const delegate = buildTccExperimentDelegate(channel, isolation)
    await delegate({ caseId: 'SPAWN-001', variant: 'tcc_projection', task: 'task', systemPrompt: 'system' })

    const call = captured[0]!
    expect(call.runtimeTools).toEqual([])
    expect(call.permissionMode).toBe('safe')
    expect(call.maxTurns).toBe(1)
    expect(call.cwd).toBe(isolation.workspaceDir)
  })

  test('maps provider usage and never reports a cache hit without cache-read tokens', async () => {
    const delegate = buildTccExperimentDelegate(channel, isolation)
    usage = { input_tokens: 120, output_tokens: 30 }
    const miss = await delegate({ caseId: 'SPAWN-001', variant: 'full_context', task: 'task', systemPrompt: 'system' })
    expect(miss).toMatchObject({ inputTokens: 120, outputTokens: 30, cacheStatus: 'miss' })

    usage = { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 80 }
    const hit = await delegate({ caseId: 'SPAWN-001', variant: 'full_context', task: 'task', systemPrompt: 'system' })
    expect(hit.cacheStatus).toBe('hit')
  })

  test('reports unknown cache status when the provider omits usage entirely', async () => {
    usage = undefined
    const delegate = buildTccExperimentDelegate(channel, isolation)
    const result = await delegate({ caseId: 'SPAWN-002', variant: 'brief', task: 'task', systemPrompt: 'system' })
    expect(result.cacheStatus).toBe('unknown')
    expect(result.inputTokens).toBe(0)
  })
})
