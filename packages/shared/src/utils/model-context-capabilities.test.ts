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
})
