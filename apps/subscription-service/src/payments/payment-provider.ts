import type { SubscriptionProvider } from '../db/subscription-store'

export interface PaymentIntentInput {
  orderId: string
  amountCny: number
  subject: string
}

export interface PaymentIntentResult {
  qrCodeContent?: string
  redirectUrl?: string
}

export interface PaymentProvider {
  provider: SubscriptionProvider
  createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>
  verifyCallback(payload: Record<string, unknown>): boolean
}

export class WechatPayProvider implements PaymentProvider {
  readonly provider = 'wechat-pay' as const
  constructor(private readonly config: { appId: string; mchId: string; apiV3Key: string; privateKeyPem: string; serialNo: string; notifyUrl: string }) {}

  async createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult> {
    // 实际接入时调用微信支付 API v3 /v3/pay/transactions/native
    // 当前返回可测试的占位二维码内容，避免在测试环境发起真实支付。
    return { qrCodeContent: `wechat://pay?appId=${this.config.appId}&mchId=${this.config.mchId}&orderId=${input.orderId}&amount=${input.amountCny}` }
  }

  verifyCallback(payload: Record<string, unknown>): boolean {
    // 实际接入时应使用平台证书/公钥验签并解密 resource
    return Boolean(payload.verified)
  }
}

export class AlipayProvider implements PaymentProvider {
  readonly provider = 'alipay' as const
  constructor(private readonly config: { appId: string; privateKeyPem: string; alipayPublicKeyPem: string; notifyUrl: string }) {}

  async createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentResult> {
    // 实际接入时调用 alipay.trade.precreate / page.pay
    return { redirectUrl: `alipay://pay?appId=${this.config.appId}&orderId=${input.orderId}&amount=${input.amountCny}` }
  }

  verifyCallback(payload: Record<string, unknown>): boolean {
    return Boolean(payload.verified)
  }
}
