import type { SubscriptionServiceConfig } from '../config'
import type { SubscriptionStore } from '../db/subscription-store'
import type { EntitlementService } from '../services/entitlement-service'
import { SUBSCRIPTION_PLANS } from '../config'
import { parseWechatCallback, type WechatCallbackData } from '../payments/wechat-pay-signature'
import {
  parseAlipayNotification,
  type AlipayNotificationData,
  type AlipayNotificationInput,
} from '../payments/alipay-signature'
import { SubscriptionLifecycleService } from '../services/subscription-lifecycle-service'

/**
 * 支付回调处理。
 *
 * 安全边界：本模块绝不信任请求体中的自述字段（例如 verified / trade_status）。
 * 微信回调必须通过平台公钥验签 + APIv3 密钥解密；
 * 支付宝回调必须通过支付宝公钥 RSA2 验签。
 * 只有验签通过的结果才允许进入权益发放流程。
 */

export interface PaymentWebhookDependencies {
  store: SubscriptionStore
  entitlementService: EntitlementService
  config: SubscriptionServiceConfig
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 微信回调金额单位为分，订单金额单位为元，需换算后比对 */
function fenToCny(fen: number): number {
  return Math.round(fen) / 100
}

async function grantPaidOrder(
  deps: PaymentWebhookDependencies,
  params: {
    provider: 'wechat-pay' | 'alipay'
    orderId: string
    providerTransactionId: string
    amountCny: number
    idempotencyKey: string
    payloadSummary: Record<string, unknown>
  },
): Promise<Response> {
  const { provider, orderId, providerTransactionId, amountCny, idempotencyKey, payloadSummary } = params

  const existingEvent = await deps.store.findPaymentEventByIdempotencyKey(idempotencyKey)
  if (existingEvent) {
    return Response.json({ ok: true, duplicated: true })
  }

  const order = await deps.store.findOrderById(orderId)
  if (!order || order.provider !== provider) {
    return Response.json(
      { code: 'order_not_found', message: '订单不存在', retryable: false },
      { status: 404 },
    )
  }

  // 金额校验：必须与订单金额完全一致，防止篡改金额购买高级套餐
  if (Math.abs(order.amountCny - amountCny) > 1e-6) {
    return Response.json(
      { code: 'amount_mismatch', message: '金额不匹配', retryable: false },
      { status: 400 },
    )
  }

  await deps.store.insertPaymentEvent({
    orderId,
    provider,
    eventType: 'payment.success',
    idempotencyKey,
    verified: true,
    payloadSummary,
  })

  // markOrderPaid 内部保证幂等：已支付订单返回空，避免重复发放权益
  const paid = await deps.store.markOrderPaid({
    orderId,
    providerTransactionId,
    paidAt: Date.now(),
  })
  if (!paid) {
    return Response.json({ ok: true, duplicated: true })
  }

  const periodMs = paid.period === 'yearly' ? 365 * DAY_MS : 30 * DAY_MS
  const now = Date.now()

  await deps.store.createSubscription({
    accountId: paid.accountId,
    planId: paid.planId,
    orderId: paid.id,
    currentPeriodStart: now,
    currentPeriodEnd: now + periodMs,
  })
  await deps.entitlementService.issueEntitlement({
    accountId: paid.accountId,
    planId: paid.planId,
    status: 'active',
    validUntil: now + periodMs,
    reason: 'order.paid',
  })

  return Response.json({ ok: true })
}

export async function handleWechatWebhook(
  request: Request,
  deps: PaymentWebhookDependencies,
): Promise<Response> {
  const wechatConfig = deps.config.wechatPay
  if (!wechatConfig?.apiV3Key || !wechatConfig.platformPublicKeyPem) {
    // 未配置凭据时不接受任何回调，避免静默降级为「不验签」
    return Response.json(
      { code: 'provider_not_configured', message: '微信支付未配置', retryable: false },
      { status: 503 },
    )
  }

  const body = await request.text()
  const parsed = parseWechatCallback({
    timestamp: request.headers.get('Wechatpay-Timestamp') ?? '',
    nonce: request.headers.get('Wechatpay-Nonce') ?? '',
    signature: request.headers.get('Wechatpay-Signature') ?? '',
    body,
    platformPublicKeyPem: wechatConfig.platformPublicKeyPem,
    apiV3Key: wechatConfig.apiV3Key,
  })

  if (!parsed.ok) {
    return Response.json(
      { code: 'invalid_callback', message: '回调验签失败', reason: parsed.reason, retryable: false },
      { status: 400 },
    )
  }

  const data: WechatCallbackData = parsed.data

  // 退款成功事件：解密的 resource 中带有 out_trade_no 与退款状态
  if (data.eventType === 'REFUND.SUCCESS' || data.tradeState === 'REFUND') {
    const lifecycle = new SubscriptionLifecycleService({
      store: deps.store,
      entitlementService: deps.entitlementService,
    })
    const result = await lifecycle.handleRefund({ orderId: data.orderId })

    // 订单不存在或不可退款时不阻断重试，交由运维排查
    if (!result.ok) {
      return Response.json(
        { code: result.reason, message: '退款处理失败', retryable: result.reason === 'order_not_found' },
        { status: result.reason === 'order_not_found' ? 404 : 200 },
      )
    }
    return Response.json({ ok: true, refunded: true })
  }

  // 仅处理支付成功事件
  if (data.tradeState !== 'SUCCESS') {
    return Response.json({ ok: true, ignored: true, tradeState: data.tradeState })
  }

  return grantPaidOrder(deps, {
    provider: 'wechat-pay',
    orderId: data.orderId,
    providerTransactionId: data.transactionId,
    amountCny: fenToCny(data.amountTotalFen),
    idempotencyKey: `wechat:${data.transactionId}`,
    payloadSummary: {
      orderId: data.orderId,
      transactionId: data.transactionId,
      amountTotalFen: data.amountTotalFen,
      eventType: data.eventType,
    },
  })
}

export async function handleAlipayWebhook(
  request: Request,
  deps: PaymentWebhookDependencies,
): Promise<Response> {
  const alipayConfig = deps.config.alipay
  if (!alipayConfig?.alipayPublicKeyPem) {
    return Response.json(
      { code: 'provider_not_configured', message: '支付宝未配置', retryable: false },
      { status: 503 },
    )
  }

  // 支付宝异步通知为 application/x-www-form-urlencoded
  const formText = await request.text()
  const params = new URLSearchParams(formText)
  const asRecord: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    asRecord[key] = value
  }

  const input: AlipayNotificationInput = {
    params: asRecord,
    alipayPublicKeyPem: alipayConfig.alipayPublicKeyPem,
  }

  const parsed = parseAlipayNotification(input)
  if (!parsed.ok) {
    // 支付宝要求验签失败时返回 failure 纯文本
    return new Response('failure', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }

  const data: AlipayNotificationData = parsed.data

  // 校验 app_id 归属，防止他人应用的回调被投递到本服务
  if (alipayConfig.appId && data.appId !== alipayConfig.appId) {
    return new Response('failure', { status: 400, headers: { 'Content-Type': 'text/plain' } })
  }

  // 验签通过但交易未完成（如 WAIT_BUYER_PAY）：返回 success 让支付宝停止重试，但不发放权益
  if (!data.isPaid) {
    return new Response('success', { headers: { 'Content-Type': 'text/plain' } })
  }

  const granted = await grantPaidOrder(deps, {
    provider: 'alipay',
    orderId: data.outTradeNo,
    providerTransactionId: data.tradeNo,
    amountCny: Number(data.totalAmount),
    idempotencyKey: `alipay:${data.tradeNo}`,
    payloadSummary: {
      orderId: data.outTradeNo,
      tradeNo: data.tradeNo,
      totalAmount: data.totalAmount,
      tradeStatus: data.tradeStatus,
    },
  })

  // 成功或重复通知均需返回 success 让支付宝停止重试
  if (granted.ok) {
    return new Response('success', { headers: { 'Content-Type': 'text/plain' } })
  }
  // 业务校验失败（订单不存在/金额不符）返回 failure，保留重试以便人工排查
  return new Response('failure', { status: 400, headers: { 'Content-Type': 'text/plain' } })
}

/** 供测试与运维使用的套餐查找辅助 */
export function findPlanOrUndefined(planId: string) {
  return SUBSCRIPTION_PLANS.find((item) => item.id === planId)
}
