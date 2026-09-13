import type { SubscriptionPlanId } from '@gravitas/shared'

/**
 * 订阅生命周期状态推导。
 *
 * 这里只做纯函数决策，不触碰数据库与网络，
 * 便于在服务端定时任务与权益签发路径中复用同一套判定规则。
 */

export type SubscriptionTransitionAction = 'keep' | 'downgrade' | 'revoke'

export interface SubscriptionTransitionInput {
  currentPlanId: SubscriptionPlanId
  subscriptionStatus: 'active' | 'expired' | 'revoked'
  currentPeriodEnd: number
  orderStatus: 'pending' | 'paid' | 'cancelled' | 'refunded' | 'expired'
  now: number
}

export interface SubscriptionTransitionDecision {
  action: SubscriptionTransitionAction
  effectivePlanId: SubscriptionPlanId
  reason: string
}

/**
 * 判定账号当前应处于的套餐与需要执行的变更动作。
 *
 * 优先级：退款 > 撤销 > 过期 > 保持。
 * 退款先于其他判断，因为退款意味着支付本身被推翻，
 * 即使订阅记录仍显示 active 也不得继续提供付费能力。
 */
export function decideSubscriptionTransition(
  input: SubscriptionTransitionInput,
): SubscriptionTransitionDecision {
  const { currentPlanId, subscriptionStatus, currentPeriodEnd, orderStatus, now } = input

  // 免费套餐无需任何变更
  if (currentPlanId === 'free') {
    return { action: 'keep', effectivePlanId: 'free', reason: 'already_free' }
  }

  // 未支付订单不代表权益成立，保持现状交由支付回调驱动
  if (orderStatus === 'pending') {
    return { action: 'keep', effectivePlanId: currentPlanId, reason: 'order_pending' }
  }

  // 订单已退款：立即收回权益
  if (orderStatus === 'refunded') {
    return { action: 'revoke', effectivePlanId: 'free', reason: 'order_refunded' }
  }

  // 订阅被显式撤销
  if (subscriptionStatus === 'revoked') {
    return { action: 'revoke', effectivePlanId: 'free', reason: 'subscription_revoked' }
  }

  // 订阅已标记过期，或当前时间已达/超过周期结束时刻
  if (subscriptionStatus === 'expired' || currentPeriodEnd <= now) {
    return { action: 'downgrade', effectivePlanId: 'free', reason: 'subscription_expired' }
  }

  return { action: 'keep', effectivePlanId: currentPlanId, reason: 'within_period' }
}

export interface DowngradeCheckInput {
  planId: SubscriptionPlanId
  validUntil: number
  now: number
  graceMs: number
  lastVerifiedAt: number
}

/**
 * 判定是否应因离线超期而降级。
 *
 * 与 decideSubscriptionTransition 的区别：本函数用于客户端缓存权益的
 * 离线可用性判定，衡量标准是「距上次成功校验的时间」而非订阅周期。
 */
export function shouldDowngrade(input: DowngradeCheckInput): boolean {
  const { planId, validUntil, now, graceMs, lastVerifiedAt } = input

  if (planId === 'free') return false

  // 权益本身仍在有效期内
  if (validUntil > now) return false

  // 权益已过期，检查是否仍在宽限窗口内
  const graceDeadline = lastVerifiedAt + graceMs
  return now > graceDeadline
}
