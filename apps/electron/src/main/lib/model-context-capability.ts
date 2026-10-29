import { getBuiltinModel, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { ChannelModel, ModelContextCapability, ProviderType } from '@gravitas/shared'
import { resolveModelContextCapability } from '@gravitas/shared'

/** 精确查询厂商目录；协议类型与模型厂商可以不同。 */
export function resolveCatalogContextWindow(provider: ProviderType, modelId: string): ModelContextCapability {
  const lookup = getBuiltinModel as unknown as (provider: string, id: string) => { contextWindow?: number } | undefined
  const originalId = modelId.trim().replace(/^models\//i, '').split('/').at(-1) ?? ''
  const vendorId = originalId.toLowerCase()
  const vendor = vendorId.startsWith('gemini-') ? 'google'
    : vendorId.startsWith('claude-') ? 'anthropic'
    : /^(gpt-|o[134](?:-|$))/.test(vendorId) ? 'openai'
    : vendorId.startsWith('deepseek-') ? 'deepseek'
    : vendorId.startsWith('glm-') ? 'zai'
    : vendorId.startsWith('minimax-') ? 'minimax'
    : provider === 'zhipu' ? 'zai'
    : provider === 'deepseek-openai' ? 'deepseek' : undefined
  const catalogProvider = vendor ?? provider
  const listModels = getBuiltinModels as unknown as (provider: string) => { id: string; contextWindow: number }[]
  const model = lookup(catalogProvider, originalId) ?? lookup(catalogProvider, vendorId)
    ?? listModels(catalogProvider).find((entry) => entry.id.toLowerCase() === vendorId)
  if (model?.contextWindow && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) {
    return { contextWindow: model.contextWindow, source: 'catalog' }
  }
  return resolveModelContextCapability({ provider, modelId })
}

/** 先使用渠道配置与 API 元数据，再查厂商目录。 */
export async function resolveChannelContextWindow(input: {
  provider: ProviderType
  modelId: string
  channelId?: string
}): Promise<ModelContextCapability> {
  let configured: ChannelModel | undefined
  if (input.channelId) {
    const { getChannelById } = await import('./channel-manager')
    configured = getChannelById(input.channelId)?.models.find((model) => model.id === input.modelId)
  }
  const capability = resolveModelContextCapability({ provider: input.provider, modelId: input.modelId, ...configured })
  if (capability.source === 'override' || capability.source === 'api' || configured?.contextWindowSource === 'catalog') return capability
  return resolveCatalogContextWindow(input.provider, input.modelId)
}


export function modelContextEndpoint(provider: ProviderType, baseUrl: string): string {
  return JSON.stringify([provider, baseUrl.trim().replace(/\/+$/, '')])
}

/** 旧配置读取时补齐目录值；不写盘，也不覆盖 API 元数据和手动值。 */
export function enrichModelContexts(provider: ProviderType, models: ChannelModel[]): ChannelModel[] {
  return models.map((model) => {
    if (model.contextWindowSource === 'api' && typeof model.contextWindow === 'number' && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0) return model
    const capability = resolveCatalogContextWindow(provider, model.id)
    return capability.source === 'catalog'
      ? { ...model, contextWindow: capability.contextWindow, contextWindowSource: 'catalog' }
      : model
  })
}
