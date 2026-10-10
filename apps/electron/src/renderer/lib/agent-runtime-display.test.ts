import { describe, expect, test } from 'bun:test'
import { formatAgentRuntimeDisplayLabel } from './agent-runtime-display'

describe('前端 Runtime 展示标签', () => {
  test('不展示已下线 Runtime 的名称', () => {
    expect(formatAgentRuntimeDisplayLabel('claude')).toBe('已下线 Runtime')
    expect(formatAgentRuntimeDisplayLabel('claude-sdk')).toBe('已下线 Runtime')
    expect(formatAgentRuntimeDisplayLabel('proma')).toBe('已下线 Runtime')
    expect(formatAgentRuntimeDisplayLabel('Gravitas Runtime')).toBe('已下线 Runtime')
  })

  test('保留当前可选 Runtime 名称', () => {
    expect(formatAgentRuntimeDisplayLabel('pi')).toBe('Pi')
    expect(formatAgentRuntimeDisplayLabel('ai-sdk')).toBe('AI SDK')
  })
})
