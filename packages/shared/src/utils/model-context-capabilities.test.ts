import { describe, expect, test } from 'bun:test'
import { resolveModelContextCapability } from './model-context-capabilities'

describe('模型上下文能力', () => {
  test('Kimi K3 使用官方 1M 窗口而 K2 系列保留各自窗口', () => {
    expect(resolveModelContextCapability({ provider: 'kimi-api', modelId: 'kimi-k3' })).toMatchObject({
      contextWindow: 1_000_000,
      source: 'catalog',
    })
    expect(resolveModelContextCapability({ provider: 'kimi-api', modelId: 'kimi-k2.6' })).toMatchObject({
      contextWindow: 256_000,
      source: 'catalog',
    })
    expect(resolveModelContextCapability({ provider: 'kimi-api', modelId: 'kimi-k2.7-code' })).toMatchObject({
      contextWindow: 256_000,
      source: 'catalog',
    })
    expect(resolveModelContextCapability({ provider: 'kimi-coding', modelId: 'kimi-for-coding' })).toMatchObject({
      contextWindow: 256_000,
      source: 'catalog',
    })
  })

  test('Kimi 渠道返回的 K3 简写也使用 1M 窗口', () => {
    expect(resolveModelContextCapability({ provider: 'kimi-api', modelId: 'K3' })).toMatchObject({
      contextWindow: 1_000_000,
      source: 'catalog',
    })
    expect(resolveModelContextCapability({ provider: 'kimi-coding', modelId: 'k3' })).toMatchObject({
      contextWindow: 1_000_000,
      source: 'catalog',
    })
  })

  test('其他厂商的 K3 名称不能借用 Kimi 能力', () => {
    expect(resolveModelContextCapability({ provider: 'custom', modelId: 'K3' })).toMatchObject({
      contextWindow: 256_000,
      source: 'fallback',
    })
  })
  test('Gemini 4 Argon 在兼容渠道也可按完整型号识别，不扩大未知型号', () => {
    expect(resolveModelContextCapability({ provider: 'custom', modelId: 'google/gemini-4-argon' })).toEqual({ contextWindow: 1_048_576, source: 'catalog' })
    expect(resolveModelContextCapability({ provider: 'google', modelId: 'gemini-unknown' }).source).toBe('fallback')
  })

  test('手动覆盖优先于 API；无覆盖时使用 API 精确值', () => {
    const input = { provider: 'custom' as const, modelId: 'gemini-4-argon', contextWindow: 900_000 }
    expect(resolveModelContextCapability(input)).toEqual({ contextWindow: 900_000, source: 'api' })
    expect(resolveModelContextCapability({ ...input, contextWindowOverride: 512_000 })).toEqual({ contextWindow: 512_000, source: 'override' })
    for (const contextWindowOverride of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(resolveModelContextCapability({ ...input, contextWindowOverride }).contextWindow).toBe(900_000)
    }
  })

  test('不再把未收录的厂商家族通配为 1M', () => {
    for (const modelId of ['claude-opus-unknown', 'deepseek-unknown', 'glm-unknown']) {
      expect(resolveModelContextCapability({ provider: 'custom', modelId }).source).toBe('fallback')
    }
  })

})
