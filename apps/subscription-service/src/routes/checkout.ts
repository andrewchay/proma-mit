import type { SubscriptionStore } from '../db/subscription-store'
import { SUBSCRIPTION_PLANS, type SubscriptionServiceConfig } from '../config'
import { AlipayProvider, WechatPayProvider, type PaymentProvider } from '../payments/payment-provider'

export interface CheckoutResponse {
  orderId: string
  provider: string
  amountCny: number
  currency: 'CNY'
  status: string
  qrCodeContent?: string
  redirectUrl?: string
}

export interface CheckoutDependencies {
  store: SubscriptionStore
  config: SubscriptionServiceConfig
}

/** 根据配置构造支付适配器。凭据缺失时返回 undefined，由调用方明确拒绝而非静默降级。 */
export function createPaymentProviders(config: SubscriptionServiceConfig): {
  wechat?: PaymentProvider
  alipay?: PaymentProvider
} {
  return {
    ...(config.wechatPay
      ? {
          wechat: new WechatPayProvider({
            appId: config.wechatPay.appId,
            mchId: config.wechatPay.mchId,
            apiV3Key: config.wechatPay.apiV3Key,
            privateKeyPem: config.wechatPay.privateKeyPem,
            serialNo: config.wechatPay.serialNo,
            notifyUrl: config.wechatPay.notifyUrl,
          }),
        }
      : {}),
    ...(config.alipay
      ? {
          alipay: new AlipayProvider({
            appId: config.alipay.appId,
            privateKeyPem: config.alipay.privateKeyPem,
            alipayPublicKeyPem: config.alipay.alipayPublicKeyPem,
            notifyUrl: config.alipay.notifyUrl,
          }),
        }
      : {}),
  }
}

export async function handleCreateCheckout(
  request: Request,
  deps: CheckoutDependencies,
  accountId: string,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const planId = typeof body?.planId === 'string' ? body.planId : ''
  const providerId = typeof body?.provider === 'string' ? body.provider : ''
  const period = body?.period === 'yearly' ? 'yearly' : 'monthly'

  const plan = SUBSCRIPTION_PLANS.find((item) => item.id === planId && item.id !== 'free')
  if (!plan) {
    return Response.json({ code: 'invalid_plan', message: '套餐不存在', retryable: false }, { status: 400 })
  }
  if (providerId !== 'wechat-pay' && providerId !== 'alipay') {
    return Response.json({ code: 'invalid_provider', message: '支付渠道不支持', retryable: false }, { status: 400 })
  }

  const amountCny = period === 'yearly' ? plan.yearlyPriceCny : plan.monthlyPriceCny
  if (amountCny <= 0) {
    return Response.json({ code: 'invalid_plan', message: '套餐价格无效', retryable: false }, { status: 400 })
  }

  const providers = createPaymentProviders(deps.config)
  const provider = providerId === 'wechat-pay' ? providers.wechat : providers.alipay

  // 渠道未配置时不创建订单，避免产生永远无法支付的悬挂订单
  if (!provider) {
    return Response.json(
      { code: 'provider_not_configured', message: '支付渠道未配置', retryable: false },
      { status: 503 },
    )
  }

  const order = await deps.store.createOrder({
    accountId,
    planId: plan.id,
    provider: providerId,
    amountCny,
    period,
    expiresAt: Date.now() + 30 * 60 * 1000,
  })

  const intent = await provider.createPaymentIntent({
    orderId: order.id,
    amountCny,
    subject: `${plan.name}（${period === 'yearly' ? '年付' : '月付'}）`,
  })

  if (!intent.ok) {
    // 渠道下单失败：订单保留待人工排查，但不向客户端返回可用二维码
    return Response.json(
      {
        code: 'payment_intent_failed',
        message: '创建支付失败，请稍后重试',
        reason: intent.reason,
        orderId: order.id,
        retryable: intent.reason === 'channel_request_failed',
      },
      { status: 502 },
    )
  }

  const response: CheckoutResponse = {
    orderId: order.id,
    provider: order.provider,
    amountCny: order.amountCny,
    currency: 'CNY',
    status: order.status,
    ...(intent.result.qrCodeContent ? { qrCodeContent: intent.result.qrCodeContent } : {}),
    ...(intent.result.redirectUrl ? { redirectUrl: intent.result.redirectUrl } : {}),
  }
  return Response.json(response)
}

export async function handleGetOrder(
  deps: CheckoutDependencies,
  accountId: string,
  orderId: string,
): Promise<Response> {
  const order = await deps.store.findOrderById(orderId)
  if (!order || order.accountId !== accountId) {
    return Response.json({ code: 'order_not_found', message: '订单不存在', retryable: false }, { status: 404 })
  }
  return Response.json({ order })
}

/**
 * 主动查单兜底。
 *
 * 用于回调丢失场景：客户端轮询该接口时，服务端向渠道查单。
 * 重要约束：查单结果**不直接发放权益**，只更新订单展示状态。
 * 权益发放必须经过回调验签，或由运营核对渠道账单后手动触发，
 * 避免仅凭一次 HTTP 响应就开通付费能力。
 */
export async function handleSyncOrder(
  deps: CheckoutDependencies,
  accountId: string,
  orderId: string,
): Promise<Response> {
  const order = await deps.store.findOrderById(orderId)
  if (!order || order.accountId !== accountId) {
    return Response.json({ code: 'order_not_found', message: '订单不存在', retryable: false }, { status: 404 })
  }

  // 已支付订单无需查单
  if (order.status === 'paid' || order.status === 'refunded') {
    return Response.json({ order, synced: false })
  }

  const providers = createPaymentProviders(deps.config)
  const provider = order.provider === 'wechat-pay' ? providers.wechat : providers.alipay
  if (!provider) {
    return Response.json({ order, synced: false, reason: 'provider_not_configured' })
  }

  const outcome = await provider.queryOrder(orderId)
  if (!outcome.ok) {
    return Response.json({
      order,
      synced: false,
      reason: outcome.reason,
    })
  }

  return Response.json({
    order,
    synced: true,
    channelPaid: outcome.paid,
    // 明确告知客户端：即使渠道显示已支付，权益仍需等待回调或人工核对后发放
    awaitingCallback: outcome.paid,
  })
}
