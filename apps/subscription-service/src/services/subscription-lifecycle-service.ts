import type { SubscriptionStore } from '../db/subscription-store'
import type { EntitlementService } from './entitlement-service'
import { decideSubscriptionTransition } from './subscription-lifecycle'

/**
 * 订阅生命周期服务。
 *
 * 负责把「状态推导」落地为实际的订阅与权益变更：
 * - 定时扫描到期订阅并降级
 * - 处理退款并立即收回权益
 *
 * 所有变更都通过签发新版本权益快照完成，客户端下一次刷新即可感知，
 * 不需要推送通道。
 */

export interface SubscriptionLifecycleDependencies {
  store: SubscriptionStore
  entitlementService: EntitlementService
}

export interface ExpirySweepResult {
  scanned: number
  downgraded: number
}

/** 单次扫描最多处理的订阅数，避免长事务与内存堆积 */
export const EXPIRY_SWEEP_BATCH_SIZE = 200

export class SubscriptionLifecycleService {
  constructor(private readonly deps: SubscriptionLifecycleDependencies) {}

  /**
   * 扫描已到期但仍为 active 的订阅，标记过期并签发降级权益。
   *
   * 返回处理数量，调用方可据此判断是否需要继续下一批。
   */
  async sweepExpiredSubscriptions(now: number = Date.now()): Promise<ExpirySweepResult> {
    const expired = await this.deps.store.findExpiredActiveSubscriptions({
      now,
      limit: EXPIRY_SWEEP_BATCH_SIZE,
    })

    let downgraded = 0
    for (const subscription of expired) {
      await this.deps.store.markSubscriptionExpired({
        subscriptionId: subscription.id,
        expiredAt: now,
      })

      await this.deps.entitlementService.issueEntitlement({
        accountId: subscription.accountId,
        planId: 'free',
        status: 'expired',
        reason: 'subscription.expired',
      })

      downgraded += 1
    }

    return { scanned: expired.length, downgraded }
  }

  /**
   * 处理退款：撤销订单关联的订阅并收回权益。
   *
   * 若订单找不到或状态不是 paid，说明重复通知或订单不存在，
   * 返回 false 由调用方决定响应，不抛异常。
   */
  async handleRefund(input: {
    orderId: string
    refundedAt?: number
  }): Promise<{ ok: boolean; reason?: string; accountId?: string }> {
    const refundedAt = input.refundedAt ?? Date.now()

    const order = await this.deps.store.findOrderById(input.orderId)
    if (!order) {
      return { ok: false, reason: 'order_not_found' }
    }

    // markOrderRefunded 带 status='paid' 条件，重复通知不会命中，天然幂等
    const refunded = await this.deps.store.markOrderRefunded({
      orderId: input.orderId,
      refundedAt,
    })
    if (!refunded) {
      return { ok: false, reason: 'order_not_refundable' }
    }

    await this.deps.store.revokeActiveSubscriptions({
      accountId: refunded.accountId,
      revokedAt: refundedAt,
    })

    await this.deps.entitlementService.issueEntitlement({
      accountId: refunded.accountId,
      planId: 'free',
      status: 'revoked',
      reason: 'order.refunded',
    })

    return { ok: true, accountId: refunded.accountId }
  }

  /**
   * 推导账号当前应处于的套餐状态，供权益查询路径复用。
   * 返回 keep 时无需任何变更。
   */
  async resolveAccountPlan(accountId: string, now: number = Date.now()) {
    const subscription = await this.deps.store.findCurrentSubscription(accountId)
    if (!subscription) {
      return { action: 'keep' as const, effectivePlanId: 'free' as const, reason: 'no_subscription' }
    }

    const order = await this.deps.store.findOrderById(subscription.orderId)

    return decideSubscriptionTransition({
      currentPlanId: subscription.planId,
      subscriptionStatus: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      orderStatus: order?.status ?? 'pending',
      now,
    })
  }
}
