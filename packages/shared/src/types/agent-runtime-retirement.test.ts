import { describe, expect, test } from 'bun:test'
import { DEFAULT_AGENT_RUNTIME, isAgentRuntime, isRetiredAgentRuntime, normalizeAgentRuntime } from './agent'

describe('Agent Runtime 软下线', () => {
  test('只禁止新选用 Claude 和 Gravitas，仍识别历史值', () => {
    expect(isRetiredAgentRuntime('claude')).toBe(true)
    expect(isRetiredAgentRuntime('proma')).toBe(true)
    expect(isRetiredAgentRuntime('pi')).toBe(false)
    expect(isRetiredAgentRuntime('ai-sdk')).toBe(false)
    expect(isAgentRuntime('claude')).toBe(true)
    expect(isAgentRuntime('proma')).toBe(true)
    expect(normalizeAgentRuntime('proma')).toBe('proma')
    expect(DEFAULT_AGENT_RUNTIME).toBe('pi')
  })
})
