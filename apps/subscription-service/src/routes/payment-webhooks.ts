import type { SubscriptionServiceConfig } from '../config'
import type { SubscriptionStore } from '../db/subscription-store'
import type { EntitlementService } from '../services/entitlement-service'
import { SUBSCRIPTION_PLANS } from '../config'

export interface PaymentWebhookDependencies {
  store: SubscriptionStore
  entitlementService: EntitlementService
  config: SubscriptionServiceConfig
}

export async function handleWechatWebhook(
  request: Request,
  deps: PaymentWebhookDependencies,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const orderId = typeof body?.orderId === 'string' ? body.orderId : ''
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId : ''
  const amountCny = typeof body?.amountCny === 'number' ? body.amountCny : 0
  const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : `${orderId}:${transactionId}`
  const verified = Boolean(body?.verified)

  if (!orderId || !transactionId || !verified) {
    return Response.json({ code: 'invalid_callback', message: '回调验签失败', retryable: false }, { status: 400 })
  }

  const existing = await deps.store.findPaymentEventByIdempotencyKey(idempotencyKey)
  if (existing) return Response.json({ ok: true, duplicated: true })

  const order = await deps.store.findOrderById(orderId)
  if (!order || order.provider !== 'wechat-pay') return Response.json({ code: 'order_not_found', message: '订单不存在', retryable: false }, { status: 404 })
  if (order.amountCny !== amountCny) return Response.json({ code: 'amount_mismatch', message: '金额不匹配', retryable: false }, { status: 400 })

  await deps.store.insertPaymentEvent({
    orderId,
    provider: 'wechat-pay',
    eventType: 'payment.success',
    idempotencyKey,
    verified: true,
    payloadSummary: { orderId, transactionId, amountCny },
  })

  const paid = await deps.store.markOrderPaid({ orderId, providerTransactionId: transactionId, paidAt: Date.now() })
  if (!paid) return Response.json({ ok: true, duplicated: true })

  const plan = SUBSCRIPTION_PLANS.find((item) => item.id === paid.planId)
  const periodMs = paid.period === 'yearly' ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
  await deps.store.createSubscription({
    accountId: paid.accountId,
    planId: paid.planId,
    orderId: paid.id,
    currentPeriodStart: Date.now(),
    currentPeriodEnd: Date.now() + periodMs,
  })
  await deps.entitlementService.issueEntitlement({
    accountId: paid.accountId,
    planId: paid.planId,
    status: 'active',
    validUntil: Date.now() + periodMs,
    reason: 'order.paid',
  })

  return Response.json({ ok: true })
}

export async function handleAlipayWebhook(
  request: Request,
  deps: PaymentWebhookDependencies,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const orderId = typeof body?.orderId === 'string' ? body.orderId : ''
  const transactionId = typeof body?.transactionId === 'string' ? body.transactionId : ''
  const amountCny = typeof body?.amountCny === 'number' ? body.amountCny : 0
  const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : `${orderId}:${transactionId}`
  const verified = Boolean(body?.verified)

  if (!orderId || !transactionId || !verified) {
    return Response.json({ code: 'invalid_callback', message: '回调验签失败', retryable: false }, { status: 400 })
  }

  const existing = await deps.store.findPaymentEventByIdempotencyKey(idempotencyKey)
  if (existing) return Response.json({ ok: true, duplicated: true })

  const order = await deps.store.findOrderById(orderId)
  if (!order || order.provider !== 'alipay') return Response.json({ code: 'order_not_found', message: '订单不存在', retryable: false }, { status: 404 })
  if (order.amountCny !== amountCny) return Response.json({ code: 'amount_mismatch', message: '金额不匹配', retryable: false }, { status: 400 })

  await deps.store.insertPaymentEvent({
    orderId,
    provider: 'alipay',
    eventType: 'payment.success',
    idempotencyKey,
    verified: true,
    payloadSummary: { orderId, transactionId, amountCny },
  })

  const paid = await deps.store.markOrderPaid({ orderId, providerTransactionId: transactionId, paidAt: Date.now() })
  if (!paid) return Response.json({ ok: true, duplicated: true })

  const periodMs = paid.period === 'yearly' ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000
  await deps.store.createSubscription({
    accountId: paid.accountId,
    planId: paid.planId,
    orderId: paid.id,
    currentPeriodStart: Date.now(),
    currentPeriodEnd: Date.now() + periodMs,
  })
  await deps.entitlementService.issueEntitlement({
    accountId: paid.accountId,
    planId: paid.planId,
    status: 'active',
    validUntil: Date.now() + periodMs,
    reason: 'order.paid',
  })

  return Response.json({ ok: true })
}
