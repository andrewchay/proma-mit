import { describe, expect, test } from 'bun:test'
import { resolvePiApi, resolvePiBaseUrl, resolvePiMaxTokens, resolvePiProviderId, shouldUsePiAuthHeader } from './pi-model-registry'

describe('pi-model-registry', () => {
  test('maps Proma providers to Pi API families', () => {
    expect(resolvePiApi('openai')).toBe('openai-completions')
    expect(resolvePiApi('zhipu')).toBe('openai-completions')
    expect(resolvePiApi('google')).toBe('google-generative-ai')
    expect(resolvePiApi('anthropic')).toBe('anthropic-messages')
    expect(resolvePiApi('kimi-coding')).toBe('anthropic-messages')
  })

  test('normalizes OpenAI-compatible base URLs for Pi runtime', () => {
    expect(resolvePiBaseUrl('openai', 'https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
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
    expect(resolvePiMaxTokens('qwen')).toBe(16_384)
    expect(resolvePiMaxTokens('kimi-coding')).toBe(32_768)
    expect(resolvePiMaxTokens('deepseek')).toBe(64_000)
  })
})
