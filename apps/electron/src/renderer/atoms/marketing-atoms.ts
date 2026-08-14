/**
 * 营销领域包订阅状态（M0：能力中心 / 订阅开关）
 *
 * 方案 v4：两个订阅式业务包（influencer 达人 / paid-media 广告投放）
 * + 共享素材能力层（两端内嵌引用）。
 * 「按需加载」= 运行时惰性初始化，非物理移除；订阅后才显示导航与可切换视图。
 *
 * 订阅状态持久化到 main 的 settings.json（marketingCapabilities），由 `marketingCapabilitiesAtom`
 * 提供内存态，经 `initializeMarketingCapabilities` 从主进程加载、`persistMarketingCapabilities` 写回。
 * main 侧 marketing-plugin.isEnabled 据此决定是否注入营销工具与指令（对齐「领域 vs 插件」边界）。
 */
import { atom } from 'jotai'

export type CapabilityId = 'influencer' | 'paid-media'
export type CapabilityKind = 'business' | 'shared'

export interface CapabilityMeta {
  id: CapabilityId | 'creative'
  label: string
  kind: CapabilityKind
  description: string
  /** 业务包声明的共享能力依赖（当前仅 creative 共享素材） */
  dependsOn?: Array<'creative'>
}

/** 领域能力清单（当前：两个业务包 + 共享素材层） */
export const CAPABILITY_MANIFEST: CapabilityMeta[] = [
  {
    id: 'creative',
    label: '共享素材',
    kind: 'shared',
    description: '图文+视频素材生产（两端内嵌引用，不独立订阅）',
  },
  {
    id: 'influencer',
    label: '达人 influencer',
    kind: 'business',
    dependsOn: ['creative'],
    description: '达人库 / 稿件三态审核（飞书机器人）/ 内容追踪',
  },
  {
    id: 'paid-media',
    label: '广告投放 paid-media',
    kind: 'business',
    dependsOn: ['creative'],
    description: '投放计划 / 调控审批 / 调控规则（首期无 API 写钱）',
  },
]

/** 默认订阅（M0 默认启用 influencer 便于首个用例验证）；与 main 侧 isEnabled 兜底一致 */
export const DEFAULT_ENABLED_CAPABILITIES: CapabilityId[] = ['influencer']

/** 已订阅的业务能力包 id（内存态；初始化自 main settings，toggle 后写回） */
export const enabledCapabilitiesAtom = atom<CapabilityId[]>(DEFAULT_ENABLED_CAPABILITIES)

/** 判断某业务包是否已订阅 */
export function isCapabilityEnabled(enabled: CapabilityId[], id: CapabilityId): boolean {
  return enabled.includes(id)
}

/** 切换某业务包订阅状态（纯函数，持久化由调用方经 persistMarketingCapabilities 处理） */
export function toggleCapability(enabled: CapabilityId[], id: CapabilityId): CapabilityId[] {
  return enabled.includes(id) ? enabled.filter((c) => c !== id) : [...enabled, id]
}

/** 从主进程加载营销订阅状态（settings.json 权威；未设置回退默认 influencer） */
export async function initializeMarketingCapabilities(
  setEnabled: (enabled: CapabilityId[]) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const stored = settings.marketingCapabilities as CapabilityId[] | undefined
    setEnabled(Array.isArray(stored) && stored.length > 0 ? stored : DEFAULT_ENABLED_CAPABILITIES)
  } catch (error) {
    console.error('[营销订阅] 加载失败，回退默认:', error)
    setEnabled(DEFAULT_ENABLED_CAPABILITIES)
  }
}

/** 持久化营销订阅状态到 main settings.json（与 main 侧 isEnabled 共享同一权威源） */
export async function persistMarketingCapabilities(enabled: CapabilityId[]): Promise<void> {
  try {
    await window.electronAPI.updateSettings({ marketingCapabilities: enabled })
  } catch (error) {
    console.error('[营销订阅] 持久化失败:', error)
  }
}
