import {
  loadSubscriptionServiceConfig,
  assertProductionConfig,
  SUBSCRIPTION_PLANS,
} from './config'
import { SubscriptionStore } from './db/subscription-store'
import { TokenService } from './services/token-service'
import { EntitlementService } from './services/entitlement-service'
import { EmailSender } from './services/email-sender'
import { RateLimiter, extractClientIp } from './services/rate-limiter'
import { authenticateRequest } from './middleware/authenticate'
import {
  handleRequestEmailOtp,
  handleVerifyEmailOtp,
  handleOAuthStart,
  handleOAuthCallback,
  handleLogout,
  handleMe,
  handleRefresh,
  type AuthRouteDependencies,
} from './routes/auth'
import { handleGetEntitlements } from './routes/entitlements'
import { handleCreateCheckout, handleGetOrder, handleSyncOrder } from './routes/checkout'
import { handleWechatWebhook, handleAlipayWebhook } from './routes/payment-webhooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

assertProductionConfig()
const config = loadSubscriptionServiceConfig()
const schemaPath = join(import.meta.dir, 'db', 'schema.sql')
const schemaSql = readFileSync(schemaPath, 'utf8')

class BunPostgresClient {
  private readonly sql: Bun.SQL
  constructor(databaseUrl: string) {
    this.sql = new Bun.SQL(databaseUrl)
  }
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    const rows = await this.sql.unsafe<Row[]>(sql, [...params])
    return { rows }
  }
}

const postgres = new BunPostgresClient(config.databaseUrl)
const store = new SubscriptionStore(postgres)
const tokenService = new TokenService(
  config.accessTokenSecret,
  config.accessTokenTtlMs,
  config.refreshTokenTtlMs,
)
const entitlementService = new EntitlementService(
  store,
  config.entitlementPrivateKeyPem,
  config.entitlementPublicKeyPem,
  config.entitlementKeyId,
)
const emailSender = new EmailSender({
  ...(config.email?.apiKey ? { apiKey: config.email.apiKey } : {}),
  ...(config.email?.from ? { from: config.email.from } : {}),
  allowConsoleFallback: config.email?.allowConsoleFallback ?? false,
})

const authDeps: AuthRouteDependencies = {
  store,
  tokenService,
  entitlementService,
  emailSender,
  emailPepper: config.emailPepper,
}

// 全局限流器。单实例内存实现；多实例部署需换成共享存储。
const limiter = new RateLimiter()

const RATE_LIMITS = {
  // 发码：每 IP 每小时 10 次，防止短信/邮件轰炸
  requestOtpByIp: { limit: 10, windowMs: 60 * 60 * 1000 },
  // 校验：每 IP 每 15 分钟 20 次，防止暴力猜码
  verifyOtpByIp: { limit: 20, windowMs: 15 * 60 * 1000 },
  // 登录态接口：每 IP 每分钟 120 次
  authenticated: { limit: 120, windowMs: 60 * 1000 },
  // 下单：每 IP 每分钟 10 次，防止批量刷单与刷渠道接口
  checkout: { limit: 10, windowMs: 60 * 1000 },
  // OAuth 起点：每 IP 每分钟 20 次
  oauthStart: { limit: 20, windowMs: 60 * 1000 },
} as const

function corsHeaders(origin: string | null): Record<string, string> {
  // 仅对白名单来源回显，避免任意站点跨域读取
  if (!origin || !config.allowedOrigins.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

function tooManyRequests(retryAfterMs: number, headers: Record<string, string>): Response {
  return Response.json(
    { code: 'rate_limited', message: '请求过于频繁，请稍后再试', retryable: true },
    {
      status: 429,
      headers: { ...headers, 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
    },
  )
}

await store.initializeSchema(schemaSql)

// 定期清理限流器的过期 bucket，避免长期运行内存增长
setInterval(() => limiter.prune(), 10 * 60 * 1000).unref?.()

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  // 限制请求体大小，避免超大 body 造成内存压力
  maxRequestBodySize: config.maxRequestBodyBytes,
  idleTimeout: 30,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const origin = request.headers.get('origin')
    const headers = corsHeaders(origin)
    const clientIp = extractClientIp(request, config.trustedProxyCidrs)

    // 预检请求：非白名单来源不返回 CORS 头，浏览器会自行拦截
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers })
    }

    if (request.method === 'GET' && path === '/healthz') {
      return Response.json({ ok: true }, { headers })
    }

    // ===== 邮箱验证码登录 =====

    if (request.method === 'POST' && path === '/v1/auth/email/request') {
      const limited = limiter.check(`otp-request:${clientIp}`, RATE_LIMITS.requestOtpByIp)
      if (!limited.allowed) return tooManyRequests(limited.retryAfterMs ?? 1000, headers)
      const response = await handleRequestEmailOtp(request, authDeps)
      return withHeaders(response, headers)
    }

    if (request.method === 'POST' && path === '/v1/auth/email/verify') {
      const limited = limiter.check(`otp-verify:${clientIp}`, RATE_LIMITS.verifyOtpByIp)
      if (!limited.allowed) return tooManyRequests(limited.retryAfterMs ?? 1000, headers)
      const response = await handleVerifyEmailOtp(request, authDeps)
      return withHeaders(response, headers)
    }

    // ===== OAuth 登录 =====

    if (request.method === 'GET' && path.startsWith('/v1/auth/oauth/')) {
      const limited = limiter.check(`oauth-start:${clientIp}`, RATE_LIMITS.oauthStart)
      if (!limited.allowed) return tooManyRequests(limited.retryAfterMs ?? 1000, headers)

      const segments = path.split('/').filter(Boolean)
      // /v1/auth/oauth/:provider/start
      const provider = segments[3] ?? ''
      const action = segments[4] ?? ''
      if (action !== 'start') {
        return Response.json(
          { code: 'not_found', message: '接口不存在', retryable: false },
          { status: 404, headers },
        )
      }
      const providerConfig =
        provider === 'github'
          ? config.oauth?.github
          : provider === 'google'
            ? config.oauth?.google
            : undefined
      const response = await handleOAuthStart(authDeps, {
        provider,
        redirectUri: providerConfig?.redirectUri ?? '',
        clientId: providerConfig?.clientId ?? '',
      })
      return withHeaders(response, headers)
    }

    if (request.method === 'POST' && path.startsWith('/v1/auth/oauth/')) {
      const segments = path.split('/').filter(Boolean)
      const provider = segments[3] ?? ''
      const action = segments[4] ?? ''
      if (action !== 'callback') {
        return Response.json(
          { code: 'not_found', message: '接口不存在', retryable: false },
          { status: 404, headers },
        )
      }
      const providerConfig =
        provider === 'github'
          ? config.oauth?.github
          : provider === 'google'
            ? config.oauth?.google
            : undefined
      if (!providerConfig?.clientId || !providerConfig.clientSecret) {
        return Response.json(
          { code: 'provider_not_configured', message: '登录方式未配置', retryable: false },
          { status: 503, headers },
        )
      }
      const body = await request.json().catch(() => undefined)
      const response = await handleOAuthCallback(authDeps, {
        provider: provider === 'github' ? 'github' : 'google',
        code: typeof body?.code === 'string' ? body.code : '',
        state: typeof body?.state === 'string' ? body.state : '',
        clientId: providerConfig.clientId,
        clientSecret: providerConfig.clientSecret,
        ...(typeof body?.deviceId === 'string' ? { deviceId: body.deviceId } : {}),
      })
      return withHeaders(response, headers)
    }

    if (request.method === 'POST' && path === '/v1/auth/refresh') {
      const response = await handleRefresh(request, authDeps)
      return withHeaders(response, headers)
    }

    // ===== 支付回调（无需认证，凭验签保证真实性）=====

    if (request.method === 'POST' && path === '/webhooks/wechat') {
      const response = await handleWechatWebhook(request, { store, entitlementService, config })
      return withHeaders(response, headers)
    }

    if (request.method === 'POST' && path === '/webhooks/alipay') {
      const response = await handleAlipayWebhook(request, { store, entitlementService, config })
      return withHeaders(response, headers)
    }

    // ===== 以下均需认证 =====

    const auth = authenticateRequest(request, (token) => tokenService.verifyAccessToken(token))
    if (!auth) {
      return Response.json(
        { code: 'unauthorized', message: '未认证', retryable: false },
        { status: 401, headers },
      )
    }

    const limited = limiter.check(`auth:${auth.accountId}`, RATE_LIMITS.authenticated)
    if (!limited.allowed) return tooManyRequests(limited.retryAfterMs ?? 1000, headers)

    if (request.method === 'POST' && path === '/v1/auth/logout') {
      const response = await handleLogout(request, authDeps, auth.sessionId)
      return withHeaders(response, headers)
    }

    if (request.method === 'GET' && path === '/v1/me') {
      const response = await handleMe(authDeps, auth.accountId)
      return withHeaders(response, headers)
    }

    if (request.method === 'GET' && path === '/v1/entitlements') {
      const response = await handleGetEntitlements({ entitlementService }, auth.accountId)
      return withHeaders(response, headers)
    }

    if (request.method === 'POST' && path === '/v1/checkout') {
      const checkoutLimited = limiter.check(`checkout:${auth.accountId}`, RATE_LIMITS.checkout)
      if (!checkoutLimited.allowed) {
        return tooManyRequests(checkoutLimited.retryAfterMs ?? 1000, headers)
      }
      const response = await handleCreateCheckout(request, { store, config }, auth.accountId)
      return withHeaders(response, headers)
    }

    if (request.method === 'POST' && path.endsWith('/sync') && path.startsWith('/v1/orders/')) {
      const orderId = path.slice('/v1/orders/'.length, path.length - '/sync'.length)
      const response = await handleSyncOrder({ store, config }, auth.accountId, orderId)
      return withHeaders(response, headers)
    }

    if (request.method === 'GET' && path.startsWith('/v1/orders/')) {
      const orderId = path.slice('/v1/orders/'.length)
      const response = await handleGetOrder({ store, config }, auth.accountId, orderId)
      return withHeaders(response, headers)
    }

    return Response.json(
      { code: 'not_found', message: '接口不存在', retryable: false },
      { status: 404, headers },
    )
  },
})

/** 把 CORS 头附加到响应上。Response 不可变，需要重建。 */
function withHeaders(response: Response, headers: Record<string, string>): Response {
  if (Object.keys(headers).length === 0) return response
  const merged = new Headers(response.headers)
  for (const [key, value] of Object.entries(headers)) merged.set(key, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  })
}

console.log(
  `订阅服务已启动：http://${server.hostname}:${server.port}（监听地址 ${config.hostname}，套餐数 ${SUBSCRIPTION_PLANS.length}）`,
)
