import { describe, expect, test, beforeAll } from 'bun:test'
import { generateKeyPairSync, createSign, createCipheriv, randomBytes } from 'node:crypto'
import { handleWechatWebhook, handleAlipayWebhook } from './payment-webhooks'
import type { SubscriptionServiceConfig } from './../config'
import type { SubscriptionStore } from './../db/subscription-store'
import type { EntitlementService } from './../services/entitlement-service'
import { buildWechatSignatureMessage } from './../payments/wechat-pay-signature'
import { buildAlipaySignContent } from './../payments/alipay-signature'

let platformPrivateKeyPem: string
let platformPublicKeyPem: string
let alipayPrivateKeyPem: string
let alipayPublicKeyPem: string
let apiV3Key: string

beforeAll(() => {
  const platform = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  platformPrivateKeyPem = platform.privateKey
  platformPublicKeyPem = platform.publicKey

  const alipay = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  alipayPrivateKeyPem = alipay.privateKey
  alipayPublicKeyPem = alipay.publicKey

  apiV3Key = randomBytes(16).toString('hex').slice(0, 32)
})

interface FakeOrder {
  id: string
  accountId: string
  planId: string
  provider: string
  amountCny: number
  period: 'monthly' | 'yearly'
  status: string
}

/** 记录调用的 fake store，仅实现 webhook 用到的查询/写入路径 */
function createFakeStore(order: FakeOrder | undefined) {
  const events = new Map<string, unknown>()
  const calls = {
    insertedEvents: [] as Array<Record<string, unknown>>,
    markedPaid: [] as string[],
    subscriptions: [] as Array<Record<string, unknown>>,
    entitlements: [] as Array<Record<string, unknown>>,
  }
  let orderStatus = order?.status ?? 'pending'

  const store = {
    findPaymentEventByIdempotencyKey: async (key: string) => events.get(key),
    findOrderById: async (id: string) => {
      if (!order || order.id !== id) return undefined
      return {
        id: order.id,
        accountId: order.accountId,
        planId: order.planId,
        provider: order.provider,
        amountCny: order.amountCny,
        period: order.period,
        status: orderStatus,
      }
    },
    insertPaymentEvent: async (input: Record<string, unknown>) => {
      calls.insertedEvents.push(input)
      events.set(String(input.idempotencyKey), input)
    },
    markOrderPaid: async (input: { orderId: string }) => {
      if (orderStatus === 'paid') return undefined
      orderStatus = 'paid'
      calls.markedPaid.push(input.orderId)
      return {
        id: order!.id,
        accountId: order!.accountId,
        planId: order!.planId,
        provider: order!.provider,
        amountCny: order!.amountCny,
        period: order!.period,
        status: 'paid',
      }
    },
    createSubscription: async (input: Record<string, unknown>) => {
      calls.subscriptions.push(input)
      return input
    },
  } as unknown as SubscriptionStore

  const entitlementService = {
    issueEntitlement: async (input: Record<string, unknown>) => {
      calls.entitlements.push(input)
      return input
    },
  } as unknown as EntitlementService

  return { store, entitlementService, calls }
}

function buildConfig(): SubscriptionServiceConfig {
  return {
    port: 4310,
    hostname: '127.0.0.1',
    databaseUrl: '',
    accessTokenSecret: '',
    accessTokenTtlMs: 0,
    refreshTokenTtlMs: 0,
    emailPepper: 'test-pepper',
    allowedOrigins: [],
    trustedProxyCidrs: [],
    maxRequestBodyBytes: 65536,
    entitlementKeyId: 'test-1',
    wechatPay: {
      appId: 'wx-app',
      mchId: 'mch-1',
      apiV3Key,
      privateKeyPem: '',
      serialNo: 'serial-1',
      notifyUrl: 'https://example.com/notify',
      platformPublicKeyPem,
    },
    alipay: {
      appId: 'app-123',
      privateKeyPem: '',
      alipayPublicKeyPem,
      notifyUrl: 'https://example.com/notify',
    },
  }
}

/** 构造合法的微信支付成功回调请求 */
function buildWechatRequest(params: { orderId: string; amountFen: number; transactionId: string }) {
  const plaintext = JSON.stringify({
    out_trade_no: params.orderId,
    transaction_id: params.transactionId,
    trade_state: 'SUCCESS',
    amount: { total: params.amountFen, currency: 'CNY' },
  })
  const nonce = 'nonce12bytes'
  const associatedData = 'transaction'
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'))
  cipher.setAAD(Buffer.from(associatedData, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64')

  const body = JSON.stringify({
    id: 'evt-1',
    event_type: 'TRANSACTION.SUCCESS',
    resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext, nonce, associated_data: associatedData },
  })

  const timestamp = String(Math.floor(Date.now() / 1000))
  const headerNonce = 'hdr-nonce'
  const signature = createSign('RSA-SHA256')
    .update(buildWechatSignatureMessage(timestamp, headerNonce, body), 'utf8')
    .sign(platformPrivateKeyPem, 'base64')

  return new Request('https://example.com/v1/payments/wechat/notify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Wechatpay-Timestamp': timestamp,
      'Wechatpay-Nonce': headerNonce,
      'Wechatpay-Signature': signature,
    },
    body,
  })
}

describe('微信支付回调：安全边界', () => {
  test('伪造 verified 的请求无法开通权益', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'wechat-pay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    // 攻击者构造：自带 verified:true，但无合法签名
    const request = new Request('https://example.com/v1/payments/wechat/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: true, orderId: 'order-1', transactionId: 'fake', amountCny: 68 }),
    })

    const response = await handleWechatWebhook(request, {
      store, entitlementService, config: buildConfig(),
    })

    expect(response.status).toBe(400)
    expect(calls.entitlements).toHaveLength(0)
    expect(calls.markedPaid).toHaveLength(0)
  })

  test('未配置凭据时拒绝回调，不静默放行', async () => {
    const { store, entitlementService, calls } = createFakeStore(undefined)
    const config = buildConfig()
    config.wechatPay = undefined

    const request = new Request('https://example.com/v1/payments/wechat/notify', {
      method: 'POST',
      body: JSON.stringify({ verified: true }),
    })

    const response = await handleWechatWebhook(request, { store, entitlementService, config })

    expect(response.status).toBe(503)
    expect(calls.entitlements).toHaveLength(0)
  })

  test('合法回调开通权益', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'wechat-pay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    const response = await handleWechatWebhook(
      buildWechatRequest({ orderId: 'order-1', amountFen: 6800, transactionId: 'wx-txn-1' }),
      { store, entitlementService, config: buildConfig() },
    )

    expect(response.status).toBe(200)
    expect(calls.markedPaid).toEqual(['order-1'])
    expect(calls.entitlements).toHaveLength(1)
  })

  test('金额被篡改时不发放权益', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'wechat-pay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    // 合法签名，但金额为 0.01 元，与订单 68 元不符
    const response = await handleWechatWebhook(
      buildWechatRequest({ orderId: 'order-1', amountFen: 1, transactionId: 'wx-txn-2' }),
      { store, entitlementService, config: buildConfig() },
    )

    expect(response.status).toBe(400)
    expect(calls.entitlements).toHaveLength(0)
  })

  test('重复回调不重复发放权益', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'wechat-pay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)
    const deps = { store, entitlementService, config: buildConfig() }

    await handleWechatWebhook(
      buildWechatRequest({ orderId: 'order-1', amountFen: 6800, transactionId: 'wx-txn-3' }),
      deps,
    )
    await handleWechatWebhook(
      buildWechatRequest({ orderId: 'order-1', amountFen: 6800, transactionId: 'wx-txn-3' }),
      deps,
    )

    expect(calls.entitlements).toHaveLength(1)
  })
})

/** 构造合法的支付宝异步通知表单 */
function buildAlipayRequest(overrides: Record<string, string> = {}) {
  const params: Record<string, string> = {
    app_id: 'app-123',
    out_trade_no: 'order-1',
    trade_no: 'alipay-txn-1',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '68.00',
    notify_id: 'notify-1',
    ...overrides,
  }
  params.sign_type = 'RSA2'
  params.sign = createSign('RSA-SHA256')
    .update(buildAlipaySignContent(params), 'utf8')
    .sign(alipayPrivateKeyPem, 'base64')

  const form = new URLSearchParams(params).toString()
  return new Request('https://example.com/v1/payments/alipay/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  })
}

describe('支付宝回调：安全边界', () => {
  test('伪造 verified 的请求无法开通权益', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'alipay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    const request = new Request('https://example.com/v1/payments/alipay/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        verified: 'true',
        out_trade_no: 'order-1',
        trade_no: 'fake',
        total_amount: '68.00',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'RSA2',
        sign: 'ZmFrZQ==',
      }).toString(),
    })

    const response = await handleAlipayWebhook(request, {
      store, entitlementService, config: buildConfig(),
    })

    expect(response.status).toBe(400)
    expect(calls.entitlements).toHaveLength(0)
  })

  test('合法通知开通权益并返回 success', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'alipay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    const response = await handleAlipayWebhook(buildAlipayRequest(), {
      store, entitlementService, config: buildConfig(),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('success')
    expect(calls.entitlements).toHaveLength(1)
  })

  test('app_id 不匹配时拒绝，防止他人应用回调', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'alipay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    const response = await handleAlipayWebhook(
      buildAlipayRequest({ app_id: 'other-app' }),
      { store, entitlementService, config: buildConfig() },
    )

    expect(response.status).toBe(400)
    expect(calls.entitlements).toHaveLength(0)
  })

  test('未支付状态不发放权益', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'alipay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    const response = await handleAlipayWebhook(
      buildAlipayRequest({ trade_status: 'WAIT_BUYER_PAY' }),
      { store, entitlementService, config: buildConfig() },
    )

    // 验签通过但非支付成功，返回 success 停止重试，且不发权益
    expect(await response.text()).toBe('success')
    expect(calls.entitlements).toHaveLength(0)
  })

  test('金额不符时不发放权益', async () => {
    const order: FakeOrder = {
      id: 'order-1', accountId: 'acc-1', planId: 'pro', provider: 'alipay',
      amountCny: 68, period: 'monthly', status: 'pending',
    }
    const { store, entitlementService, calls } = createFakeStore(order)

    const response = await handleAlipayWebhook(
      buildAlipayRequest({ total_amount: '0.01' }),
      { store, entitlementService, config: buildConfig() },
    )

    expect(response.status).toBe(400)
    expect(calls.entitlements).toHaveLength(0)
  })
})
