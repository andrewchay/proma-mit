import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS } from '@gravitas/shared'
import type { ProviderType } from '@gravitas/shared'

/** 默认以供应商命名；自定义端点优先使用域名，无法解析时保留通用名称。 */
export function suggestChannelName(provider: ProviderType, baseUrl: string): string {
  if (provider === 'custom') {
    try {
      const hostname = new URL(baseUrl.trim()).hostname.replace(/^www\./, '')
      if (hostname) return hostname
    } catch { /* 用户尚未填完 URL */ }
    return '自定义配置'
  }
  // 非官方端点可用域名区分同一供应商的多套配置。
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const defaultHostname = new URL(PROVIDER_DEFAULT_URLS[provider]).hostname
    if (hostname && hostname !== defaultHostname) return `${PROVIDER_LABELS[provider]} · ${hostname}`
  } catch { /* 使用供应商默认名称 */ }
  return PROVIDER_LABELS[provider]
}
