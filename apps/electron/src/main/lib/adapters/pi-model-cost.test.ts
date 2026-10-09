import { describe, expect, test } from 'bun:test'
import { PROVIDER_DEFAULT_URLS } from '@gravitas/shared'
import { resolvePiModelCost } from './pi-model-registry'

describe('Pi 渠道模型费用（费用闸门输入）', () => {
  test('官方端点且目录命中时使用目录价，供请求级费用闸门计算', async () => {
    const cost = await resolvePiModelCost('deepseek', PROVIDER_DEFAULT_URLS.deepseek, 'deepseek-flash')
    expect(cost.input).toBe(0.3)
    expect(cost.output).toBe(1.2)
  })
  test('第三方中转即使模型 ID 相同也保持未知（0），不套用官方价格', async () => {
    const cost = await resolvePiModelCost('deepseek', 'https://relay.example.invalid/anthropic', 'deepseek-flash')
    expect(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
  test('官方端点但目录未收录的模型保持未知（0）', async () => {
    const cost = await resolvePiModelCost('deepseek', PROVIDER_DEFAULT_URLS.deepseek, 'not-in-catalog-model')
    expect(cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})
