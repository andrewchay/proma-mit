import type { NewMediaPlatform } from '@gravitas/shared'
import type { PlatformAdapter } from './platform-adapter'
import { PlatformAdapterError } from './platform-adapter'
import { xiaohongshuLocalAdapter } from './adapters/xiaohongshu-local-adapter'
import { wechatOfficialAccountLocalAdapter } from './adapters/wechat-official-account-local-adapter'

export class PlatformAdapterRegistry {
  private readonly adapters = new Map<NewMediaPlatform, PlatformAdapter>()

  register(adapter: PlatformAdapter): void {
    if (this.adapters.has(adapter.platform)) throw new Error(`平台 Adapter 已注册: ${adapter.platform}`)
    this.adapters.set(adapter.platform, adapter)
  }

  get(platform: NewMediaPlatform): PlatformAdapter {
    const adapter = this.adapters.get(platform)
    if (!adapter) throw new PlatformAdapterError('adapter_not_found', `未找到平台 Adapter: ${platform}`)
    return adapter
  }

  list(): PlatformAdapter[] {
    return [...this.adapters.values()]
  }
}

export function createDefaultPlatformAdapterRegistry(): PlatformAdapterRegistry {
  const registry = new PlatformAdapterRegistry()
  registry.register(xiaohongshuLocalAdapter)
  registry.register(wechatOfficialAccountLocalAdapter)
  return registry
}

let registry = createDefaultPlatformAdapterRegistry()

export function getPlatformAdapterRegistry(): PlatformAdapterRegistry {
  return registry
}

export function setPlatformAdapterRegistryForTesting(value?: PlatformAdapterRegistry): void {
  registry = value ?? createDefaultPlatformAdapterRegistry()
}
