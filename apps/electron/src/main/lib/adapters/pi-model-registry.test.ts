import { describe, expect, test } from 'bun:test'
import { resolvePiApi, resolvePiBaseUrl, resolvePiMaxTokens, resolvePiProviderId, shouldUsePiAuthHeader, inferPiContextWindow } from './pi-model-registry'

describe('pi-model-registry', () => {
  test('maps Proma providers to Pi API families', () => {
    expect(resolvePiApi('openai')).toBe('openai-completions')
    expect(resolvePiApi('deepseek-openai')).toBe('openai-completions')
    expect(resolvePiApi('zhipu')).toBe('openai-completions')
    expect(resolvePiApi('google')).toBe('google-generative-ai')
    expect(resolvePiApi('anthropic')).toBe('anthropic-messages')
    expect(resolvePiApi('kimi-coding')).toBe('anthropic-messages')
  })

  test('normalizes OpenAI-compatible base URLs for Pi runtime', () => {
    expect(resolvePiBaseUrl('openai', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(resolvePiBaseUrl('deepseek-openai', 'https://api.deepseek.com/')).toBe('https://api.deepseek.com')
    expect(resolvePiBaseUrl('custom', 'https://gateway.example.com/v1/')).toBe('https://gateway.example.com/v1')
    expect(resolvePiBaseUrl('deepseek', 'https://api.deepseek.com/anthropic/')).toBe('https://api.deepseek.com/anthropic')
    expect(resolvePiBaseUrl('google', 'https://generativelanguage.googleapis.com')).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(resolvePiBaseUrl('google', 'https://generativelanguage.googleapis.com/v1beta')).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(resolvePiBaseUrl('kimi-coding', 'https://api.kimi.com/coding/v1')).toBe('https://api.kimi.com/coding')
    expect(resolvePiBaseUrl('kimi-coding', 'https://api.kimi.com/coding/v1/messages')).toBe('https://api.kimi.com/coding')
  })

  test('creates safe temporary provider IDs per session', () => {
    expect(resolvePiProviderId('openai', 'session:1/2')).toBe('proma-openai-session-1-2')
  })

  test('applies provider-specific Pi auth and token limits', () => {
    expect(shouldUsePiAuthHeader('google')).toBe(false)
    expect(shouldUsePiAuthHeader('qwen')).toBe(true)
    expect(shouldUsePiAuthHeader('deepseek-openai')).toBe(true)
    expect(resolvePiMaxTokens('qwen')).toBe(16_384)
    expect(resolvePiMaxTokens('kimi-coding')).toBe(32_768)
    expect(resolvePiMaxTokens('deepseek')).toBe(64_000)
    expect(resolvePiMaxTokens('deepseek-openai')).toBe(64_000)
  })

  test('核心供应商模型使用 1M context window，未知模型回退到 256K', () => {
    expect(inferPiContextWindow('claude-opus-4-5')).toBe(1_000_000)
    expect(inferPiContextWindow('claude-opus-4-7')).toBe(1_000_000)
    expect(inferPiContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
    expect(inferPiContextWindow('gpt-5.6')).toBe(1_000_000)
    expect(inferPiContextWindow('gpt-5.6-sol')).toBe(1_000_000)
    expect(inferPiContextWindow('kimi-k2.5')).toBe(256_000)
    expect(inferPiContextWindow('moonshot-v1-auto')).toBe(256_000)
    expect(inferPiContextWindow('deepseek-chat')).toBe(1_000_000)
    expect(inferPiContextWindow('deepseek-v4-flash')).toBe(1_000_000)
    expect(inferPiContextWindow('glm-4.5')).toBe(1_000_000)
    expect(inferPiContextWindow('claude-haiku-4-5')).toBe(200_000)
    expect(inferPiContextWindow('claude-sonnet-4-5')).toBe(256_000)
    expect(inferPiContextWindow('gpt-4o')).toBe(256_000)
    expect(inferPiContextWindow(undefined)).toBe(256_000)
  })
})
