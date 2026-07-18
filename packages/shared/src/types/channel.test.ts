import { describe, expect, test } from 'bun:test'
import {
  AGENT_COMPATIBLE_PROVIDERS,
  getAgentCompatibleProviders,
  getAgentProviderProtocol,
  isAgentCompatibleProvider,
  resolveAgentRuntimeBaseUrl,
} from './channel'

describe('Agent provider runtime capabilities', () => {
  test('默认 Agent 兼容判断保持 Claude runtime 行为', () => {
    expect(isAgentCompatibleProvider('anthropic')).toBe(true)
    expect(isAgentCompatibleProvider('kimi-api')).toBe(true)
    expect(isAgentCompatibleProvider('openai')).toBe(false)
    expect(isAgentCompatibleProvider('custom')).toBe(false)
  })

  test('Proma runtime 开放 OpenAI-compatible provider，Pi runtime 开放 SDK 可注册 provider', () => {
    expect(getAgentCompatibleProviders('proma').sort()).toEqual([
      'custom',
      'deepseek',
      'doubao',
      'kimi-api',
      'kimi-coding',
      'openai',
      'qwen',
      'zhipu',
    ])
    expect(isAgentCompatibleProvider('google', 'proma')).toBe(false)
    expect(getAgentCompatibleProviders('pi').sort()).toEqual([
      'anthropic',
      'custom',
      'deepseek',
      'doubao',
      'google',
      'kimi-api',
      'kimi-coding',
      'minimax',
      'openai',
      'qwen',
      'zhipu',
    ])
  })

  test('旧 AGENT_COMPATIBLE_PROVIDERS 常量等价于 Claude runtime provider 集合', () => {
    expect([...AGENT_COMPATIBLE_PROVIDERS].sort()).toEqual(getAgentCompatibleProviders('claude').sort())
  })

  test('DeepSeek 在 Claude 和 Proma runtime 下使用不同协议', () => {
    expect(getAgentProviderProtocol('deepseek', 'claude')).toBe('anthropic-messages')
    expect(getAgentProviderProtocol('deepseek', 'proma')).toBe('openai-chat')
    expect(getAgentProviderProtocol('kimi-api', 'claude')).toBe('anthropic-messages')
    expect(getAgentProviderProtocol('kimi-api', 'proma')).toBe('openai-chat')
    expect(getAgentProviderProtocol('kimi-coding', 'claude')).toBe('anthropic-messages')
    expect(getAgentProviderProtocol('kimi-coding', 'proma')).toBe('openai-chat')
    expect(getAgentProviderProtocol('openai', 'proma')).toBe('openai-chat')
    expect(getAgentProviderProtocol('google', 'pi')).toBe('google-generative')
    expect(getAgentProviderProtocol('openai', 'pi')).toBe('openai-chat')
    expect(getAgentProviderProtocol('anthropic', 'pi')).toBe('anthropic-messages')
  })

  test('Proma runtime 会把 Anthropic 兼容端点转换为 OpenAI-compatible 根路径', () => {
    expect(resolveAgentRuntimeBaseUrl('deepseek', 'proma', 'https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com')
    expect(resolveAgentRuntimeBaseUrl('deepseek', 'proma', 'https://api.deepseek.com/anthropic/v1')).toBe('https://api.deepseek.com')
    expect(resolveAgentRuntimeBaseUrl('deepseek', 'claude', 'https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com/anthropic')
    expect(resolveAgentRuntimeBaseUrl('kimi-api', 'proma', 'https://api.moonshot.cn/anthropic')).toBe('https://api.moonshot.cn')
    expect(resolveAgentRuntimeBaseUrl('kimi-api', 'proma', 'https://api.moonshot.cn/anthropic/v1/messages')).toBe('https://api.moonshot.cn')
    expect(resolveAgentRuntimeBaseUrl('kimi-coding', 'proma', 'https://api.kimi.com/coding/v1/messages')).toBe('https://api.kimi.com')
    expect(resolveAgentRuntimeBaseUrl('kimi-coding', 'claude', 'https://api.kimi.com/coding/v1/messages')).toBe('https://api.kimi.com/coding/v1/messages')
    expect(resolveAgentRuntimeBaseUrl('openai', 'proma', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
  })
})
