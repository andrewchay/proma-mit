import type { SubscriptionStore } from '../db/subscription-store'
import { SUBSCRIPTION_PLANS } from '../config'

export interface CheckoutResponse {
  orderId: string
  provider: string
  amountCny: number
  currency: 'CNY'
  status: string
  qrCodeContent?: string
  redirectUrl?: string
}

export async function handleCreateCheckout(
  request: Request,
  deps: { store: SubscriptionStore },
  accountId: string,
): Promise<Response> {
  const body = await request.json().catch(() => undefined)
  const planId = typeof body?.planId === 'string' ? body.planId : ''
  const provider = typeof body?.provider === 'string' ? body.provider : ''
  const period = body?.period === 'yearly' ? 'yearly' : 'monthly'

  const plan = SUBSCRIPTION_PLANS.find((item) => item.id === planId && item.id !== 'free')
  if (!plan) return Response.json({ code: 'invalid_plan', message: '套餐不存在', retryable: false }, { status: 400 })
  if (provider !== 'wechat-pay' && provider !== 'alipay') return Response.json({ code: 'invalid_provider', message: '支付渠道不支持', retryable: false }, { status: 400 })

  const amountCny = period === 'yearly' ? plan.yearlyPriceCny : plan.monthlyPriceCny
  if (amountCny <= 0) return Response.json({ code: 'invalid_plan', message: '套餐价格无效', retryable: false }, { status: 400 })

  const order = await deps.store.createOrder({
    accountId,
    planId: plan.id,
    provider,
    amountCny,
    period,
    expiresAt: Date.now() + 30 * 60 * 1000,
  })

  const response: CheckoutResponse = {
    orderId: order.id,
    provider: order.provider,
    amountCny: order.amountCny,
    currency: 'CNY',
    status: order.status,
    ...(provider === 'wechat-pay' ? { qrCodeContent: `wechat://pay?orderId=${order.id}` } : {}),
    ...(provider === 'alipay' ? { redirectUrl: `alipay://pay?orderId=${order.id}` } : {}),
  }
  return Response.json(response)
}

export async function handleGetOrder(
  deps: { store: SubscriptionStore },
  accountId: string,
  orderId: string,
): Promise<Response> {
  const order = await deps.store.findOrderById(orderId)
  if (!order || order.accountId !== accountId) return Response.json({ code: 'order_not_found', message: '订单不存在', retryable: false }, { status: 404 })
  return Response.json({ order })
}
