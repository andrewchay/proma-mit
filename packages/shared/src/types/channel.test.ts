import { describe, expect, test } from 'bun:test'
import {
  AGENT_COMPATIBLE_PROVIDERS,
  getAgentCompatibleProviders,
  getAgentProviderProtocol,
  isAgentCompatibleProvider,
} from './channel'

describe('Agent provider runtime capabilities', () => {
  test('默认 Agent 兼容判断保持 Claude runtime 行为', () => {
    expect(isAgentCompatibleProvider('anthropic')).toBe(true)
    expect(isAgentCompatibleProvider('kimi-api')).toBe(true)
    expect(isAgentCompatibleProvider('openai')).toBe(false)
    expect(isAgentCompatibleProvider('custom')).toBe(false)
  })

  test('Proma runtime 开放 OpenAI-compatible provider，暂不开放 Google 和 Pi provider', () => {
    expect(getAgentCompatibleProviders('proma').sort()).toEqual([
      'custom',
      'deepseek',
      'doubao',
      'openai',
      'qwen',
      'zhipu',
    ])
    expect(isAgentCompatibleProvider('google', 'proma')).toBe(false)
    expect(getAgentCompatibleProviders('pi')).toEqual([])
  })

  test('旧 AGENT_COMPATIBLE_PROVIDERS 常量等价于 Claude runtime provider 集合', () => {
    expect([...AGENT_COMPATIBLE_PROVIDERS].sort()).toEqual(getAgentCompatibleProviders('claude').sort())
  })

  test('DeepSeek 在 Claude 和 Proma runtime 下使用不同协议', () => {
    expect(getAgentProviderProtocol('deepseek', 'claude')).toBe('anthropic-messages')
    expect(getAgentProviderProtocol('deepseek', 'proma')).toBe('openai-chat')
    expect(getAgentProviderProtocol('openai', 'proma')).toBe('openai-chat')
  })
})
