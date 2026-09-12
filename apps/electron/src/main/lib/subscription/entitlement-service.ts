import type { EntitlementSnapshot } from '@gravitas/shared'
import { DEFAULT_ENTITLEMENT_GRACE_MS, canUseCapability, getEntitlementStatus, type SubscriptionCapabilityId } from '@gravitas/shared'
import type { SubscriptionApiClient } from './subscription-api-client'
import type { SubscriptionAuthService } from './subscription-auth-service'
import type { EntitlementCache } from './entitlement-cache'

export interface SubscriptionState {
  accountId?: string
  displayName?: string
  entitlement: EntitlementSnapshot | null
  status: 'active' | 'grace' | 'expired' | 'none'
  canUse: (capability: SubscriptionCapabilityId) => boolean
}

export class EntitlementService {
  constructor(
    private readonly apiClient: SubscriptionApiClient,
    private readonly authService: SubscriptionAuthService,
    private readonly cache: EntitlementCache,
  ) {}

  getState(): SubscriptionState {
    const cached = this.cache.load()
    const tokens = this.authService.load()
    const now = new Date()
    const entitlement = cached?.snapshot ?? null
    const status = entitlement ? getEntitlementStatus(entitlement, now) : 'none'
    return {
      ...(tokens ? { accountId: tokens.accessToken ? undefined : undefined } : {}),
      entitlement,
      status,
      canUse: (capability) => canUseCapability(entitlement, capability, now),
    }
  }

  async login(input: { phone: string; displayName?: string }): Promise<SubscriptionState> {
    const response = await this.apiClient.login(input)
    this.authService.save({ accessToken: response.accessToken, refreshToken: response.refreshToken, expiresAt: response.expiresAt })
    this.cache.save(response.entitlement)
    return this.getState()
  }

  async refresh(): Promise<SubscriptionState> {
    const tokens = this.authService.load()
    if (!tokens) return this.getState()
    try {
      const response = await this.apiClient.refresh(tokens.refreshToken)
      this.authService.save({ accessToken: response.accessToken, refreshToken: response.refreshToken, expiresAt: response.expiresAt })
      this.cache.save(response.entitlement)
    } catch {
      // 刷新失败时保留现有缓存，由宽限期逻辑决定是否降级
    }
    return this.getState()
  }

  async logout(): Promise<void> {
    this.authService.clear()
    this.cache.clear()
  }

  isInGracePeriod(): boolean {
    const cached = this.cache.load()
    if (!cached) return false
    const graceUntil = cached.snapshot.graceUntil
      ? new Date(cached.snapshot.graceUntil).getTime()
      : new Date(cached.snapshot.lastVerifiedAt).getTime() + DEFAULT_ENTITLEMENT_GRACE_MS
    return graceUntil >= Date.now()
  }
}
