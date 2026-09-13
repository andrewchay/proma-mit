import type { EntitlementSnapshot } from '@gravitas/shared'
import {
  DEFAULT_ENTITLEMENT_GRACE_MS,
  canUseCapability,
  getEntitlementStatus,
  type SubscriptionCapabilityId,
} from '@gravitas/shared'
import type { SubscriptionApiClient } from './subscription-api-client'
import type { SubscriptionAuthService } from './subscription-auth-service'
import type { EntitlementCache } from './entitlement-cache'
import { verifyEntitlementSnapshotSignature, isDevSignature } from './entitlement-signature'

export interface SubscriptionState {
  accountId?: string
  displayName?: string
  entitlement: EntitlementSnapshot | null
  status: 'active' | 'grace' | 'expired' | 'none'
  /**
   * 服务连通性状态，用于区分「确实未订阅」与「服务不可达」。
   * 此前两者在 UI 上无法区分，用户已付费却看到「未订阅」。
   */
  connectivity: 'online' | 'offline' | 'unknown'
  canUse: (capability: SubscriptionCapabilityId) => boolean
}

export interface EntitlementServiceOptions {
  /** 权益签名公钥。缺失时拒绝接受任何签名快照。 */
  entitlementPublicKeyPem?: string
  /** 是否接受开发签名。仅开发环境为 true。 */
  allowDevSignature?: boolean
}

export class EntitlementService {
  constructor(
    private readonly apiClient: SubscriptionApiClient,
    private readonly authService: SubscriptionAuthService,
    private readonly cache: EntitlementCache,
    private readonly options: EntitlementServiceOptions = {},
  ) {}

  /**
   * 读取本地缓存快照，并校验签名。
   *
   * 签名校验是防伪的核心：本地缓存文件可被用户直接编辑，
   * 不校验签名则任何人都能把 planId 改成 pro 解锁全部付费能力。
   * 校验失败时返回 undefined，等同于无权益。
   */
  private loadVerifiedSnapshot(): EntitlementSnapshot | undefined {
    const cached = this.cache.load()
    if (!cached?.snapshot) return undefined

    const result = verifyEntitlementSnapshotSignature(
      cached.snapshot,
      this.options.entitlementPublicKeyPem ?? '',
      { allowDevSignature: this.options.allowDevSignature ?? false },
    )

    if (!result.ok) {
      // 不把失败原因直接抛给 UI，避免泄露内部校验细节；
      // 但记录一条警告便于诊断「权益突然消失」类问题
      console.warn(`[subscription] 权益快照签名校验失败，已忽略本地缓存：${result.reason}`)
      return undefined
    }

    return cached.snapshot
  }

  getState(): SubscriptionState {
    const entitlement = this.loadVerifiedSnapshot() ?? null
    const now = new Date()
    const status = entitlement ? getEntitlementStatus(entitlement, now) : 'none'

    return {
      entitlement,
      status,
      // 有可信快照即视为曾成功连通过，具体在线状态由 refresh 结果更新
      connectivity: entitlement ? 'unknown' : 'unknown',
      canUse: (capability) => canUseCapability(entitlement, capability, now),
    }
  }

  async verifyEmailOtp(input: { email: string; code: string; deviceId?: string }): Promise<SubscriptionState> {
    const response = await this.apiClient.verifyEmailOtp(input)
    this.authService.save({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt: response.expiresAt,
    })
    this.cache.save(response.entitlement)
    return this.getState()
  }

  async requestEmailOtp(input: { email: string }): Promise<void> {
    await this.apiClient.requestEmailOtp(input)
  }

  /** 用授权码完成第三方登录 */
  async completeOAuthLogin(input: {
    provider: 'github' | 'google'
    code: string
    state: string
    deviceId?: string
  }): Promise<SubscriptionState> {
    const response = await this.apiClient.completeOAuth(input)
    this.authService.save({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt: response.expiresAt,
    })
    this.cache.save(response.entitlement)
    return this.getState()
  }

  /** 获取第三方登录授权地址 */
  async startOAuth(provider: 'github' | 'google'): Promise<{ authorizeUrl: string; state: string }> {
    return this.apiClient.startOAuth(provider)
  }

  async refresh(): Promise<SubscriptionState> {
    const tokens = this.authService.load()
    if (!tokens) return this.getState()

    try {
      const response = await this.apiClient.refresh(tokens.refreshToken)
      this.authService.save({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        expiresAt: response.expiresAt,
      })
      this.cache.save(response.entitlement)
      return { ...this.getState(), connectivity: 'online' }
    } catch {
      // 刷新失败：保留上一次已验签的缓存，由宽限期逻辑决定是否降级
      return { ...this.getState(), connectivity: 'offline' }
    }
  }

  async logout(): Promise<void> {
    const tokens = this.authService.load()

    // 先通知服务端吊销会话，避免本地清了但服务端 refresh token 仍可用
    if (tokens?.accessToken) {
      try {
        await this.apiClient.logout(tokens.accessToken)
      } catch {
        // 服务端不可达时仍继续本地登出，但服务端会话会在 TTL 后自然过期
      }
    }

    this.authService.clear()
    this.cache.clear()
  }

  /**
   * 是否仍处于离线宽限期内。
   *
   * 判定依据是「距上次成功校验的时间」，而非订阅周期结束时间，
   * 因为该逻辑用于断网场景：短暂断网可继续使用，长期离线则降级。
   */
  isInGracePeriod(now: number = Date.now()): boolean {
    const cached = this.cache.load()
    if (!cached?.snapshot) return false
    if (isDevSignature(cached.snapshot.signature)) return true

    const snapshot = cached.snapshot
    // 订阅本身仍在有效期内
    if (snapshot.validUntil) {
      const validUntil = new Date(snapshot.validUntil).getTime()
      if (validUntil > now) return true
    }

    const graceUntil = snapshot.graceUntil
      ? new Date(snapshot.graceUntil).getTime()
      : new Date(snapshot.lastVerifiedAt).getTime() + DEFAULT_ENTITLEMENT_GRACE_MS

    return graceUntil > now
  }

  /** 返回当前令牌对应的账号 ID，供 UI 展示 */
  getAccountId(): string | undefined {
    return this.loadVerifiedSnapshot()?.accountId
  }
}
