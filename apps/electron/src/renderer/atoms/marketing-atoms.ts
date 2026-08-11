/**
 * 营销领域包订阅状态（M0：能力中心 / 订阅开关）
 *
 * 方案 v4：两个订阅式业务包（influencer 达人 / paid-media 广告投放）
 * + 共享素材能力层（两端内嵌引用）。
 * 「按需加载」= 运行时惰性初始化，非物理移除；订阅后才显示导航与可切换视图。
 */
import { atomWithStorage } from 'jotai/utils'

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

/** 已订阅的业务能力包 id（M0 默认启用 influencer 便于首个用例验证） */
export const enabledCapabilitiesAtom = atomWithStorage<CapabilityId[]>(
  'proma-marketing-enabled-capabilities',
  ['influencer'],
)

/** 判断某业务包是否已订阅 */
export function isCapabilityEnabled(enabled: CapabilityId[], id: CapabilityId): boolean {
  return enabled.includes(id)
}

/** 切换某业务包订阅状态 */
export function toggleCapability(enabled: CapabilityId[], id: CapabilityId): CapabilityId[] {
  return enabled.includes(id) ? enabled.filter((c) => c !== id) : [...enabled, id]
}
