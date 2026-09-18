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
export type SubscriptionCapabilityId = 
  | 'influencer' 
  | 'paid-media' 
  | 'outbound-sourcing'
  | 'knowledge-basic'      // 知识库基础版（免费版可用）
  | 'analysis-basic'       // 分析引擎基础版（免费版可用）
  | 'academic'             // 学术助手插件（Pro 插件）
  | 'knowledge-pro'        // 知识库专业版（Pro 插件）
  | 'analysis-pro'         // 分析引擎专业版（Pro 插件）

/** 免费版即可使用的基础能力 */
export const FREE_CAPABILITIES: SubscriptionCapabilityId[] = [
  'knowledge-basic',
  'analysis-basic',
]

/** 判断是否为免费版能力 */
export function isFreeCapability(capability: SubscriptionCapabilityId): boolean {
  return FREE_CAPABILITIES.includes(capability)
}

/**
 * 全部受订阅控制的付费能力。
 *
 * 用途：本地调试放开（见 main/lib/dev-unlock.ts）时一次性授予，避免逐个模拟
 * 服务端签发。业务判定请使用 canUseCapability，不要直接拿这份清单当权限。
 */
export const PAID_CAPABILITIES: SubscriptionCapabilityId[] = [
  'influencer',
  'paid-media',
  'outbound-sourcing',
  'academic',
  'knowledge-pro',
  'analysis-pro',
]

/** 全部能力（免费 + 付费），同上，仅用于调试放开与展示。 */
export const ALL_SUBSCRIPTION_CAPABILITIES: SubscriptionCapabilityId[] = [
  ...FREE_CAPABILITIES,
  ...PAID_CAPABILITIES,
]

/**
 * 业务包能力（达人 / 投放 / 出海 sourcing）。
 *
 * 这三个能力同时是 settings.json 里的本地偏好开关取值
 * （marketingCapabilities / domainCapabilities），两侧必须保持一致。
 */
export const BUSINESS_PACKAGE_CAPABILITIES: SubscriptionCapabilityId[] = [
  'influencer',
  'paid-media',
  'outbound-sourcing',
]

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
  // 免费版能力：无需订阅即可使用
  if (isFreeCapability(capability)) {
    return true
  }
  
  // Pro 版能力：需要有效权益
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
  /** 请求邮箱验证码 */
  REQUEST_EMAIL_CODE: 'subscription:request-email-code',
  /** 校验邮箱验证码并登录 */
  VERIFY_EMAIL_CODE: 'subscription:verify-email-code',
  /** 获取第三方登录授权地址 */
  START_OAUTH: 'subscription:start-oauth',
  /** 用授权码完成第三方登录 */
  COMPLETE_OAUTH: 'subscription:complete-oauth',
  /** 登出 */
  LOGOUT: 'subscription:logout',
  /** 刷新 access token 与权益 */
  REFRESH: 'subscription:refresh',
  /** 读取当前订阅服务地址 */
  GET_ENDPOINT: 'subscription:get-endpoint',
  /** 设置订阅服务地址 */
  SET_ENDPOINT: 'subscription:set-endpoint',
  /** 创建支付订单 */
  CREATE_CHECKOUT: 'subscription:create-checkout',
  /** 查询订单状态 */
  GET_ORDER: 'subscription:get-order',
  /** 主动同步订单状态（回调丢失时的兜底） */
  SYNC_ORDER: 'subscription:sync-order',
} as const
