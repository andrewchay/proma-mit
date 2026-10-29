import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import catalog from './model-context-catalog.generated.json'
import { describe, expect, mock, test } from 'bun:test'
import type { ChannelModel } from '@gravitas/shared'

const models: ChannelModel[] = [
  { id: 'gemini-4-argon', name: 'Gemini', enabled: true, contextWindow: 1_048_576, contextWindowSource: 'api', contextWindowOverride: 512_000 },
  { id: 'relay-alias', name: '代理别名', enabled: true, contextWindow: 750_000, contextWindowSource: 'api' },
]
mock.module('./channel-manager', () => ({ getChannelById: () => ({ models }) }))
const { resolveChannelContextWindow, resolveCatalogContextWindow } = await import('./model-context-capability')

describe('渠道上下文窗口', () => {
  test('相同模型在渠道内优先使用手动值，其他渠道保持目录值', async () => {
    expect(await resolveChannelContextWindow({ provider: 'custom', modelId: 'gemini-4-argon', channelId: 'relay' })).toEqual({ contextWindow: 512_000, source: 'override' })
    expect(await resolveChannelContextWindow({ provider: 'custom', modelId: 'gemini-4-argon' })).toEqual({ contextWindow: 1_048_576, source: 'catalog' })
  })
  test('代理返回的别名可使用该端点返回的元数据', async () => {
    expect(await resolveChannelContextWindow({ provider: 'custom', modelId: 'relay-alias', channelId: 'relay' })).toEqual({ contextWindow: 750_000, source: 'api' })
  })
  test('按模型厂商精确查询，不把协议 provider 当成模型厂商', () => {
    expect(resolveCatalogContextWindow('custom', 'openai/gpt-4o')).toEqual({ contextWindow: 128_000, source: 'catalog' })
    expect(resolveCatalogContextWindow('custom', 'claude-opus-4-5')).toEqual({ contextWindow: 200_000, source: 'catalog' })
    expect(resolveCatalogContextWindow('minimax', 'MiniMax-M2.7')).toEqual({ contextWindow: 204_800, source: 'catalog' })
    expect(resolveCatalogContextWindow('custom', 'minimax-m3')).toEqual({ contextWindow: 1_000_000, source: 'catalog' })
    expect(resolveCatalogContextWindow('custom', 'claude-opus-made-up').source).toBe('fallback')
  })
})


test('打包窗口目录与已锁定的 SDK 一致，升级依赖后必须重新生成', () => {
  const listModels = getBuiltinModels as unknown as (provider: string) => { id: string; contextWindow: number }[]
  const directories: Record<string, Record<string, number>> = catalog.windows
  for (const [provider, windows] of Object.entries(directories)) {
    expect(windows).toEqual(Object.fromEntries(listModels(provider).map((model) => [model.id, model.contextWindow])))
  }
})
