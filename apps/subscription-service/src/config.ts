import type { SubscriptionPlanId } from '@gravitas/shared'

export interface SubscriptionServiceConfig {
  port: number
  /** 监听地址。默认仅本机，公网部署需显式设为 0.0.0.0 并置于反向代理后 */
  hostname: string
  databaseUrl: string
  /** 仅用于本地/测试；生产环境通过密钥管理注入，绝不提交 Git */
  accessTokenSecret: string
  accessTokenTtlMs: number
  refreshTokenTtlMs: number
  /** 邮箱与验证码哈希使用的服务端 pepper，泄露会导致可离线反推 */
  emailPepper: string
  /** 邮件发送服务（Resend）配置 */
  email?: {
    apiKey: string
    from: string
    /** 仅开发环境开启；生产禁用，避免验证码进日志 */
    allowConsoleFallback: boolean
  }
  /** 允许跨域访问的来源白名单。空数组表示不允许任何浏览器来源 */
  allowedOrigins: readonly string[]
  /** 可信反向代理网段，用于识别真实客户端 IP；为空时不信任 X-Forwarded-For */
  trustedProxyCidrs: readonly string[]
  /** 请求体大小上限（字节） */
  maxRequestBodyBytes: number
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
  oauth?: {
    github?: { clientId: string; clientSecret: string; redirectUri: string }
    google?: { clientId: string; clientSecret: string; redirectUri: string }
  }
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * 生产环境必须显式提供的密钥。
 * 缺失时启动即失败，避免静默使用公开默认值导致 token 可被伪造。
 */
export const REQUIRED_IN_PRODUCTION: readonly string[] = [
  'SUBSCRIPTION_DATABASE_URL',
  'SUBSCRIPTION_ACCESS_TOKEN_SECRET',
  'SUBSCRIPTION_EMAIL_PEPPER',
  'SUBSCRIPTION_ENTITLEMENT_PRIVATE_KEY_PEM',
  'SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM',
]

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new Error(
      `生产环境缺少必需的环境变量，拒绝以不安全默认值启动：${missing.join(', ')}`,
    )
  }
  if (env.SUBSCRIPTION_ACCESS_TOKEN_SECRET === 'dev-only-secret-change-me') {
    throw new Error('生产环境不得使用开发默认的 access token 密钥')
  }
}

export function loadSubscriptionServiceConfig(env: NodeJS.ProcessEnv = process.env): SubscriptionServiceConfig {
  const isProduction = env.NODE_ENV === 'production'
  return {
    port: Number(env.SUBSCRIPTION_SERVICE_PORT ?? 4310),
    // 默认只监听本机。以前不传 hostname，Bun 会监听 0.0.0.0，
    // 而启动日志却打印 localhost，会误导运维以为服务未对外暴露。
    hostname: env.SUBSCRIPTION_SERVICE_HOSTNAME ?? '127.0.0.1',
    databaseUrl: env.SUBSCRIPTION_DATABASE_URL ?? 'postgres://localhost:5432/gravitas_subscription',
    accessTokenSecret: env.SUBSCRIPTION_ACCESS_TOKEN_SECRET ?? 'dev-only-secret-change-me',
    accessTokenTtlMs: Number(env.SUBSCRIPTION_ACCESS_TOKEN_TTL_MS ?? 15 * 60 * 1000),
    refreshTokenTtlMs: Number(env.SUBSCRIPTION_REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
    emailPepper: env.SUBSCRIPTION_EMAIL_PEPPER ?? 'dev-only-email-pepper',
    // 开发环境即使未配置 Resend 也提供 email 配置对象，
    // 以便 EmailSender 走控制台回退，让本地能完整联调登录流程。
    // 生产环境未配置 Key 时保持 undefined，发码直接失败而非静默降级。
    email:
      env.RESEND_API_KEY || !isProduction
        ? {
            apiKey: env.RESEND_API_KEY ?? '',
            from: env.SUBSCRIPTION_EMAIL_FROM ?? '',
            // 仅非生产环境允许控制台回退，避免验证码进入生产日志
            allowConsoleFallback: !isProduction,
          }
        : undefined,
    allowedOrigins: parseList(env.SUBSCRIPTION_ALLOWED_ORIGINS),
    trustedProxyCidrs: parseList(env.SUBSCRIPTION_TRUSTED_PROXY_CIDRS),
    maxRequestBodyBytes: Number(env.SUBSCRIPTION_MAX_REQUEST_BODY_BYTES ?? 64 * 1024),
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
    oauth:
      env.GITHUB_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID
        ? {
            ...(env.GITHUB_OAUTH_CLIENT_ID
              ? {
                  github: {
                    clientId: env.GITHUB_OAUTH_CLIENT_ID,
                    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
                    redirectUri: env.GITHUB_OAUTH_REDIRECT_URI ?? '',
                  },
                }
              : {}),
            ...(env.GOOGLE_OAUTH_CLIENT_ID
              ? {
                  google: {
                    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
                    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
                    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI ?? '',
                  },
                }
              : {}),
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
