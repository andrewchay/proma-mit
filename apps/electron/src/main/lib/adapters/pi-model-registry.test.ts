import { describe, expect, test } from 'bun:test'
import { resolvePiApi, resolvePiBaseUrl, resolvePiProviderId } from './pi-model-registry'

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
  })

  test('creates safe temporary provider IDs per session', () => {
    expect(resolvePiProviderId('openai', 'session:1/2')).toBe('proma-openai-session-1-2')
  })
})
