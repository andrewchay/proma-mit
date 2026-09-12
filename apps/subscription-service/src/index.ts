import { loadSubscriptionServiceConfig, SUBSCRIPTION_PLANS } from './config'
import { SubscriptionStore } from './db/subscription-store'
import { TokenService } from './services/token-service'
import { EntitlementService } from './services/entitlement-service'
import { authenticateRequest } from './middleware/authenticate'
import { handleLogin, handleLogout, handleMe, handleRefresh } from './routes/auth'
import { handleGetEntitlements } from './routes/entitlements'
import { handleCreateCheckout, handleGetOrder } from './routes/checkout'
import { handleWechatWebhook, handleAlipayWebhook } from './routes/payment-webhooks'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const config = loadSubscriptionServiceConfig()
const schemaPath = join(import.meta.dir, 'db', 'schema.sql')
const schemaSql = readFileSync(schemaPath, 'utf8')

class BunPostgresClient {
  private readonly sql: Bun.SQL
  constructor(databaseUrl: string) {
    this.sql = new Bun.SQL(databaseUrl)
  }
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: Row[] }> {
    const rows = await this.sql.unsafe<Row[]>(sql, [...params])
    return { rows }
  }
}

const postgres = new BunPostgresClient(config.databaseUrl)
const store = new SubscriptionStore(postgres)
const tokenService = new TokenService(config.accessTokenSecret, config.accessTokenTtlMs, config.refreshTokenTtlMs)
const entitlementService = new EntitlementService(store, config.entitlementPrivateKeyPem, config.entitlementPublicKeyPem, config.entitlementKeyId)

await store.initializeSchema(schemaSql)

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'GET' && path === '/healthz') {
      return Response.json({ ok: true })
    }

    if (request.method === 'POST' && path === '/v1/auth/login') {
      return handleLogin(request, { store, tokenService, entitlementService })
    }

    if (request.method === 'POST' && path === '/v1/auth/refresh') {
      return handleRefresh(request, { store, tokenService, entitlementService })
    }

    const auth = authenticateRequest(request, (token) => tokenService.verifyAccessToken(token))

    if (request.method === 'POST' && path === '/v1/auth/logout') {
      if (!auth) return Response.json({ code: 'unauthorized', message: '未认证', retryable: false }, { status: 401 })
      return handleLogout(request, { store, tokenService, entitlementService }, auth.sessionId)
    }

    if (request.method === 'GET' && path === '/v1/me') {
      if (!auth) return Response.json({ code: 'unauthorized', message: '未认证', retryable: false }, { status: 401 })
      return handleMe({ store, tokenService, entitlementService }, auth.accountId)
    }

    if (request.method === 'GET' && path === '/v1/entitlements') {
      if (!auth) return Response.json({ code: 'unauthorized', message: '未认证', retryable: false }, { status: 401 })
      return handleGetEntitlements({ entitlementService }, auth.accountId)
    }

    if (request.method === 'POST' && path === '/v1/checkout') {
      if (!auth) return Response.json({ code: 'unauthorized', message: '未认证', retryable: false }, { status: 401 })
      return handleCreateCheckout(request, { store }, auth.accountId)
    }

    if (request.method === 'GET' && path.startsWith('/v1/orders/')) {
      if (!auth) return Response.json({ code: 'unauthorized', message: '未认证', retryable: false }, { status: 401 })
      const orderId = path.slice('/v1/orders/'.length)
      return handleGetOrder({ store }, auth.accountId, orderId)
    }

    if (request.method === 'POST' && path === '/webhooks/wechat') {
      return handleWechatWebhook(request, { store, entitlementService, config })
    }

    if (request.method === 'POST' && path === '/webhooks/alipay') {
      return handleAlipayWebhook(request, { store, entitlementService, config })
    }

    return Response.json({ code: 'not_found', message: '接口不存在', retryable: false }, { status: 404 })
  },
})

console.log(`[subscription-service] listening on http://localhost:${server.port}`)
