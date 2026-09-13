/**
 * 营销领域包与订阅权益（M0：能力中心 / 订阅开关）
 *
 * 方案 v4：两个订阅式业务包（influencer 达人 / paid-media 广告投放）
 * + 共享素材能力层（两端内嵌引用）。
 * 「按需加载」= 运行时惰性初始化，非物理移除；订阅后才显示导航与可切换视图。
 *
 * 商业化后的权限模型（重要）：
 * - `enabledCapabilitiesAtom` 现在只是**用户偏好**（是否希望显示某个包），
 *   持久化在 settings.json，用户可自由开关。
 * - 实际能否使用由 `activeCapabilitiesAtom` 决定：本地开关 AND 订阅权益。
 * - 因此单独修改 settings.json 中的 marketingCapabilities 不再能解锁付费能力，
 *   必须持有服务端签发且验签通过的权益快照。
 *
 * main 侧 marketing-plugin.isEnabled 同样按「本地开关 AND 权益」判定。
 */
import { atom } from 'jotai'
import { subscriptionStateAtom, selectCanUseCapability } from './subscription-atoms'

export type CapabilityId = 'influencer' | 'paid-media' | 'outbound-sourcing'
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
  {
    id: 'outbound-sourcing',
    label: '出海 sourcing',
    kind: 'business',
    // 能力边界如实描述：与 Redvia 全流水线不同，这里只覆盖方法论三件套，检索/核验由 Agent 完成，发送需人工
    description: '检索核验 / 画像 / 评分 / 外联与回复草稿 / 邮件同步 / 审批制发送 / 漏斗指标',
  },
]

/** 默认订阅（默认不开启任何业务包；用户可在领域工作台手动启用）；与 main 侧 isEnabled 兜底一致 */
export const DEFAULT_ENABLED_CAPABILITIES: CapabilityId[] = []

/** 已订阅的业务能力包 id（内存态；初始化自 main settings，toggle 后写回） */
export const enabledCapabilitiesAtom = atom<CapabilityId[]>(DEFAULT_ENABLED_CAPABILITIES)

/**
 * 实际可用的能力包 = 用户本地开启 且 订阅权益允许。
 *
 * 这是权限判定的唯一权威来源，所有展示与功能门禁都应基于此 atom，
 * 而不是直接读 enabledCapabilitiesAtom。
 */
export const activeCapabilitiesAtom = atom<CapabilityId[]>((get) => {
  const preferred = get(enabledCapabilitiesAtom)
  const subscriptionState = get(subscriptionStateAtom)
  return preferred.filter((id) => selectCanUseCapability(subscriptionState, id))
})

/** 判断某能力当前是否真的可用（需同时满足本地开启与权益） */
export function isCapabilityActive(
  active: CapabilityId[],
  id: CapabilityId,
): boolean {
  return active.includes(id)
}

/** 判断某业务包是否已订阅 */
export function isCapabilityEnabled(enabled: CapabilityId[], id: CapabilityId): boolean {
  return enabled.includes(id)
}

/** 切换某业务包订阅状态（纯函数，持久化由调用方经 persistMarketingCapabilities 处理） */
export function toggleCapability(enabled: CapabilityId[], id: CapabilityId): CapabilityId[] {
  return enabled.includes(id) ? enabled.filter((c) => c !== id) : [...enabled, id]
}

/** 从主进程加载营销订阅状态（settings.json 权威；未设置回退默认不开启） */
export async function initializeMarketingCapabilities(
  setEnabled: (enabled: CapabilityId[]) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const marketing = Array.isArray(settings.marketingCapabilities) ? settings.marketingCapabilities : []
    const domains = Array.isArray(settings.domainCapabilities) ? settings.domainCapabilities : []
    const stored = [...new Set([...marketing, ...domains])] as CapabilityId[]
    setEnabled(stored.length > 0 ? stored : DEFAULT_ENABLED_CAPABILITIES)
  } catch (error) {
    console.error('[营销订阅] 加载失败，回退默认:', error)
    setEnabled(DEFAULT_ENABLED_CAPABILITIES)
  }
}

/** 持久化营销订阅状态到 main settings.json（与 main 侧 isEnabled 共享同一权威源） */
export async function persistMarketingCapabilities(enabled: CapabilityId[]): Promise<void> {
  try {
    await window.electronAPI.updateSettings({
      marketingCapabilities: enabled.filter((id) => id === 'influencer' || id === 'paid-media'),
      domainCapabilities: enabled.filter((id) => id === 'outbound-sourcing'),
    })
  } catch (error) {
    console.error('[营销订阅] 持久化失败:', error)
  }
}
