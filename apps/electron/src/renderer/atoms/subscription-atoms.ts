import { atom } from 'jotai'
import type { EntitlementSnapshot, SubscriptionCapabilityId } from '@gravitas/shared'
import { canUseCapability, getEntitlementStatus, isFreeCapability } from '@gravitas/shared'

export interface SubscriptionState {
  accountId?: string
  displayName?: string
  entitlement: EntitlementSnapshot | null
  status: 'active' | 'grace' | 'expired' | 'none'
  /**
   * 服务连通性，用于区分「确实未订阅」与「服务不可达」。
   * 未登录前为 unknown。
   */
  connectivity?: 'online' | 'offline' | 'unknown'
}

export const subscriptionStateAtom = atom<SubscriptionState>({
  entitlement: null,
  status: 'none',
  connectivity: 'unknown',
})

export function selectCanUseCapability(
  state: SubscriptionState,
  capability: SubscriptionCapabilityId,
): boolean {
  // 免费版能力：无需订阅即可使用
  if (isFreeCapability(capability)) {
    return true
  }
  
  if (!state.entitlement) return false
  const now = new Date()
  const status = getEntitlementStatus(state.entitlement, now)
  if (status !== 'active' && status !== 'grace') return false
  return canUseCapability(state.entitlement, capability, now)
}

/** 已登录：存在可信权益快照或账号信息 */
export const isSubscriptionLoggedInAtom = atom(
  (get) => Boolean(get(subscriptionStateAtom).accountId ?? get(subscriptionStateAtom).entitlement),
)

/** 服务不可达：已登录但刷新失败，此时 UI 应提示而非显示「未订阅」 */
export const isSubscriptionOfflineAtom = atom(
  (get) => get(subscriptionStateAtom).connectivity === 'offline',
)

export const canUseInfluencerAtom = atom((get) =>
  selectCanUseCapability(get(subscriptionStateAtom), 'influencer'),
)
export const canUsePaidMediaAtom = atom((get) =>
  selectCanUseCapability(get(subscriptionStateAtom), 'paid-media'),
)
export const canUseOutboundSourcingAtom = atom((get) =>
  selectCanUseCapability(get(subscriptionStateAtom), 'outbound-sourcing'),
)
