/**
 * 订阅与权益领域模型
 *
 * 客户端只消费服务端签名的权益快照；本模块只包含跨进程共享的纯类型与纯函数，
 * 不读取本地配置、不发起网络请求、不保存任何敏感凭据。
 */

/** 当前可购买的订阅层 */
export type SubscriptionPlanId = 'free' | 'pro'

/** 客户端可见的权益状态 */
export type EntitlementStatus = 'active' | 'grace' | 'expired' | 'none'

/** 当前受订阅控制的能力包 */
export type SubscriptionCapabilityId = 'influencer' | 'paid-media' | 'outbound-sourcing'

/** 服务端签名的权益快照（不含 access token / refresh token / 支付密钥） */
export interface EntitlementSnapshot {
  accountId: string
  planId: SubscriptionPlanId
  capabilities: SubscriptionCapabilityId[]
  status: EntitlementStatus
  validUntil?: string
  lastVerifiedAt: string
  graceUntil?: string
  signature: string
  keyId: string
}

/** 离线宽限期：最近一次成功校验后的可用时长 */
export const DEFAULT_ENTITLEMENT_GRACE_MS = 72 * 60 * 60 * 1000

/** 计算指定时间点的权益状态 */
export function getEntitlementStatus(snapshot: EntitlementSnapshot, now: Date): EntitlementStatus {
  if (snapshot.status === 'active') {
    if (!snapshot.validUntil) return 'active'
    return new Date(snapshot.validUntil).getTime() >= now.getTime() ? 'active' : 'expired'
  }

  if (snapshot.status === 'grace') {
    const graceUntil = snapshot.graceUntil
      ? new Date(snapshot.graceUntil).getTime()
      : new Date(snapshot.lastVerifiedAt).getTime() + DEFAULT_ENTITLEMENT_GRACE_MS
    return graceUntil >= now.getTime() ? 'grace' : 'expired'
  }

  return snapshot.status
}

/** 判断指定能力在当前时间点是否可用 */
export function canUseCapability(
  snapshot: EntitlementSnapshot | null,
  capability: SubscriptionCapabilityId,
  now: Date,
): boolean {
  if (!snapshot) return false
  if (getEntitlementStatus(snapshot, now) !== 'active' && getEntitlementStatus(snapshot, now) !== 'grace') {
    return false
  }
  return snapshot.capabilities.includes(capability)
}

/** 订阅 IPC 通道 */
export const SUBSCRIPTION_IPC_CHANNELS = {
  /** 获取当前账户与权益状态 */
  GET_STATE: 'subscription:get-state',
  /** 登录/注册 */
  LOGIN: 'subscription:login',
  /** 登出 */
  LOGOUT: 'subscription:logout',
  /** 刷新 access token 与权益 */
  REFRESH: 'subscription:refresh',
  /** 创建支付订单 */
  CREATE_CHECKOUT: 'subscription:create-checkout',
  /** 查询订单状态 */
  GET_ORDER: 'subscription:get-order',
} as const
