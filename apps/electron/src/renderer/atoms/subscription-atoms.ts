import { atom } from 'jotai'
import type { EntitlementSnapshot, SubscriptionCapabilityId } from '@gravitas/shared'
import { canUseCapability, getEntitlementStatus } from '@gravitas/shared'

export interface SubscriptionState {
  accountId?: string
  displayName?: string
  entitlement: EntitlementSnapshot | null
  status: 'active' | 'grace' | 'expired' | 'none'
}

export const subscriptionStateAtom = atom<SubscriptionState>({
  entitlement: null,
  status: 'none',
})

export function selectCanUseCapability(state: SubscriptionState, capability: SubscriptionCapabilityId): boolean {
  if (!state.entitlement) return false
  const now = new Date()
  const status = getEntitlementStatus(state.entitlement, now)
  if (status !== 'active' && status !== 'grace') return false
  return canUseCapability(state.entitlement, capability, now)
}

export const canUseInfluencerAtom = atom((get) => selectCanUseCapability(get(subscriptionStateAtom), 'influencer'))
export const canUsePaidMediaAtom = atom((get) => selectCanUseCapability(get(subscriptionStateAtom), 'paid-media'))
export const canUseOutboundSourcingAtom = atom((get) => selectCanUseCapability(get(subscriptionStateAtom), 'outbound-sourcing'))
