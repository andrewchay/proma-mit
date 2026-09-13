import type { SubscriptionPlanId } from '@gravitas/shared'

export interface SubscriptionServiceConfig {
  port: number
  databaseUrl: string
  /** 仅用于本地/测试；生产环境通过密钥管理注入，绝不提交 Git */
  accessTokenSecret: string
  accessTokenTtlMs: number
  refreshTokenTtlMs: number
  entitlementPrivateKeyPem?: string
  entitlementPublicKeyPem?: string
  entitlementKeyId: string
  wechatPay?: {
    appId: string
    mchId: string
    apiV3Key: string
    privateKeyPem: string
    serialNo: string
    notifyUrl: string
    /** 微信支付平台证书公钥，用于回调验签。由商户平台下载后以环境变量注入 */
    platformPublicKeyPem: string
  }
  alipay?: {
    appId: string
    privateKeyPem: string
    alipayPublicKeyPem: string
    notifyUrl: string
  }
}

export function loadSubscriptionServiceConfig(env: NodeJS.ProcessEnv = process.env): SubscriptionServiceConfig {
  return {
    port: Number(env.SUBSCRIPTION_SERVICE_PORT ?? 4310),
    databaseUrl: env.SUBSCRIPTION_DATABASE_URL ?? 'postgres://localhost:5432/gravitas_subscription',
    accessTokenSecret: env.SUBSCRIPTION_ACCESS_TOKEN_SECRET ?? 'dev-only-secret-change-me',
    accessTokenTtlMs: Number(env.SUBSCRIPTION_ACCESS_TOKEN_TTL_MS ?? 15 * 60 * 1000),
    refreshTokenTtlMs: Number(env.SUBSCRIPTION_REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
    entitlementPrivateKeyPem: env.SUBSCRIPTION_ENTITLEMENT_PRIVATE_KEY_PEM,
    entitlementPublicKeyPem: env.SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM,
    entitlementKeyId: env.SUBSCRIPTION_ENTITLEMENT_KEY_ID ?? 'dev-1',
    wechatPay: env.WECHAT_PAY_APP_ID
      ? {
          appId: env.WECHAT_PAY_APP_ID,
          mchId: env.WECHAT_PAY_MCH_ID ?? '',
          apiV3Key: env.WECHAT_PAY_API_V3_KEY ?? '',
          privateKeyPem: env.WECHAT_PAY_PRIVATE_KEY_PEM ?? '',
          serialNo: env.WECHAT_PAY_SERIAL_NO ?? '',
          notifyUrl: env.WECHAT_PAY_NOTIFY_URL ?? '',
          platformPublicKeyPem: env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM ?? '',
        }
      : undefined,
    alipay: env.ALIPAY_APP_ID
      ? {
          appId: env.ALIPAY_APP_ID,
          privateKeyPem: env.ALIPAY_PRIVATE_KEY_PEM ?? '',
          alipayPublicKeyPem: env.ALIPAY_PUBLIC_KEY_PEM ?? '',
          notifyUrl: env.ALIPAY_NOTIFY_URL ?? '',
        }
      : undefined,
  }
}

export interface SubscriptionPlanDefinition {
  id: SubscriptionPlanId
  name: string
  monthlyPriceCny: number
  yearlyPriceCny: number
  capabilities: string[]
}

export const SUBSCRIPTION_PLANS: SubscriptionPlanDefinition[] = [
  {
    id: 'free',
    name: '免费版',
    monthlyPriceCny: 0,
    yearlyPriceCny: 0,
    capabilities: [],
  },
  {
    id: 'pro',
    name: '专业版',
    monthlyPriceCny: 68,
    yearlyPriceCny: 680,
    capabilities: ['influencer', 'paid-media', 'outbound-sourcing'],
  },
]
