import { describe, expect, test } from 'bun:test'
import { getAgentRuntimeLabel, isAgentRuntime, normalizeAgentRuntime } from './agent'

describe('Agent runtime 类型', () => {
  test('识别 AI SDK runtime 并保留旧值回退行为', () => {
    expect(isAgentRuntime('ai-sdk')).toBe(true)
    expect(getAgentRuntimeLabel('ai-sdk')).toBe('AI SDK')
    expect(normalizeAgentRuntime('unknown')).toBe('claude')
  })
})
