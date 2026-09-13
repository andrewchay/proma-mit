import { describe, expect, test, beforeAll } from 'bun:test'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import {
  AlipayProvider,
  WechatPayProvider,
  buildWechatRequestSignatureMessage,
  cnyToFen,
  formatAlipayTimestamp,
} from './payment-provider'

let merchantPrivateKeyPem: string
let merchantPublicKeyPem: string

beforeAll(() => {
  const merchant = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  merchantPrivateKeyPem = merchant.privateKey
  merchantPublicKeyPem = merchant.publicKey
})

const wechatConfig = () => ({
  appId: 'wx-app',
  mchId: 'mch-1',
  apiV3Key: 'a'.repeat(32),
  privateKeyPem: merchantPrivateKeyPem,
  serialNo: 'serial-1',
  notifyUrl: 'https://example.com/notify',
})

const alipayConfig = () => ({
  appId: 'app-1',
  privateKeyPem: merchantPrivateKeyPem,
  alipayPublicKeyPem: merchantPublicKeyPem,
  notifyUrl: 'https://example.com/notify',
})

describe('金额与时间格式', () => {
  test('元转分避免浮点误差', () => {
    expect(cnyToFen(68)).toBe(6800)
    expect(cnyToFen(0.01)).toBe(1)
    expect(cnyToFen(6800.55)).toBe(680055)
    // 经典的浮点陷阱：0.1 + 0.2 不等于 0.3
    expect(cnyToFen(0.1 + 0.2)).toBe(30)
  })

  test('支付宝时间戳格式为 yyyy-MM-dd HH:mm:ss', () => {
    const formatted = formatAlipayTimestamp(new Date(2026, 8, 13, 8, 5, 3))
    expect(formatted).toBe('2026-09-13 08:05:03')
  })

  test('微信请求签名串按 方法\\nURL\\ntimestamp\\nnonce\\nbody\\n 构造', () => {
    const message = buildWechatRequestSignatureMessage(
      'POST', '/v3/pay/transactions/native', '1700000000', 'nonce1', '{"a":1}',
    )
    expect(message).toBe('POST\n/v3/pay/transactions/native\n1700000000\nnonce1\n{"a":1}\n')
  })
})

describe('微信支付下单', () => {
  test('凭据齐全时发起真实请求并返回二维码内容', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined

    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async (url, init) => {
        capturedUrl = url
        capturedInit = init
        return new Response(JSON.stringify({ code_url: 'weixin://wxpay/bizpayurl?pr=abc' }), {
          status: 200,
        })
      },
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Gravitas Pro',
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.qrCodeContent).toBe('weixin://wxpay/bizpayurl?pr=abc')
    }
    expect(capturedUrl).toContain('/v3/pay/transactions/native')

    // 请求体金额以分为单位，且携带商户号与回调地址
    const body = JSON.parse(String(capturedInit?.body))
    expect(body.amount.total).toBe(6800)
    expect(body.amount.currency).toBe('CNY')
    expect(body.mchid).toBe('mch-1')
    expect(body.notify_url).toBe('https://example.com/notify')

    // Authorization 头包含商户号与序列号，且签名为 base64
    const authHeader = (capturedInit?.headers as Record<string, string>).Authorization
    expect(authHeader).toContain('WECHATPAY2-SHA256-RSA2048')
    expect(authHeader).toContain('mchid="mch-1"')
    expect(authHeader).toContain('serial_no="serial-1"')
  })

  test('签名可被商户公钥验证，证明请求确实用私钥签名', async () => {
    let capturedInit: RequestInit | undefined

    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async (_url, init) => {
        capturedInit = init
        return new Response(JSON.stringify({ code_url: 'weixin://x' }), { status: 200 })
      },
    })

    await provider.createPaymentIntent({ orderId: 'order-1', amountCny: 68, subject: 'Pro' })

    const authHeader = (capturedInit?.headers as Record<string, string>).Authorization
    const signatureMatch = authHeader.match(/signature="([^"]+)"/)
    const timestampMatch = authHeader.match(/timestamp="([^"]+)"/)
    const nonceMatch = authHeader.match(/nonce_str="([^"]+)"/)
    expect(signatureMatch).toBeTruthy()

    const message = buildWechatRequestSignatureMessage(
      'POST',
      '/v3/pay/transactions/native',
      timestampMatch![1],
      nonceMatch![1],
      String(capturedInit?.body),
    )
    const verifier = createVerify('RSA-SHA256')
    verifier.update(message, 'utf8')
    expect(verifier.verify(merchantPublicKeyPem, signatureMatch![1], 'base64')).toBe(true)
  })

  test('凭据缺失时不发起请求', async () => {
    let called = false
    const provider = new WechatPayProvider({
      ...wechatConfig(),
      privateKeyPem: '',
      fetchImpl: async () => {
        called = true
        return new Response('{}', { status: 200 })
      },
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Pro',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('provider_not_configured')
    expect(called).toBe(false)
  })

  test('渠道拒绝时返回 channel_rejected 并带错误详情', async () => {
    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 'PARAM_ERROR', message: '参数错误' }), { status: 400 }),
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Pro',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('channel_rejected')
  })

  test('渠道返回缺少 code_url 时视为响应异常', async () => {
    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async () => new Response(JSON.stringify({ something: 'else' }), { status: 200 }),
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Pro',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('malformed_channel_response')
  })

  test('网络异常被捕获为 channel_request_failed，不抛出', async () => {
    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Pro',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('channel_request_failed')
      expect(outcome.detail).toContain('ECONNREFUSED')
    }
  })
})

describe('微信支付查单', () => {
  test('交易成功时返回 paid 与渠道流水号', async () => {
    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            trade_state: 'SUCCESS',
            transaction_id: 'wx-txn-1',
            amount: { total: 6800 },
          }),
          { status: 200 },
        ),
    })

    const outcome = await provider.queryOrder('order-1')

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.paid).toBe(true)
      expect(outcome.providerTransactionId).toBe('wx-txn-1')
      expect(outcome.amountCny).toBe(68)
    }
  })

  test('未支付时 paid 为 false', async () => {
    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ trade_state: 'NOTPAY' }), { status: 200 }),
    })

    const outcome = await provider.queryOrder('order-1')

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.paid).toBe(false)
  })

  test('查单 URL 携带商户号', async () => {
    let capturedUrl = ''
    const provider = new WechatPayProvider({
      ...wechatConfig(),
      fetchImpl: async (url) => {
        capturedUrl = url
        return new Response(JSON.stringify({ trade_state: 'NOTPAY' }), { status: 200 })
      },
    })

    await provider.queryOrder('order-1')

    expect(capturedUrl).toContain('/v3/pay/transactions/out-trade-no/order-1')
    expect(capturedUrl).toContain('mchid=mch-1')
  })
})

describe('支付宝下单', () => {
  test('凭据齐全时调用 precreate 并返回二维码', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    const provider = new AlipayProvider({
      ...alipayConfig(),
      fetchImpl: async (url, init) => {
        capturedUrl = url
        capturedBody = String(init?.body)
        return new Response(
          JSON.stringify({
            alipay_trade_precreate_response: { code: '10000', qr_code: 'https://qr.alipay.com/abc' },
          }),
          { status: 200 },
        )
      },
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Gravitas Pro',
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.qrCodeContent).toBe('https://qr.alipay.com/abc')
    }

    // 平台参数在 URL query
    const query = new URL(capturedUrl).searchParams
    expect(query.get('method')).toBe('alipay.trade.precreate')
    expect(query.get('sign_type')).toBe('RSA2')
    expect(query.get('sign')).toBeTruthy()

    // 业务参数在 body
    const bodyParams = new URLSearchParams(capturedBody)
    const bizContent = JSON.parse(bodyParams.get('biz_content') ?? '{}')
    // 支付宝金额为字符串且保留两位小数
    expect(bizContent.total_amount).toBe('68.00')
    expect(bizContent.out_trade_no).toBe('order-1')
  })

  test('签名可被应用公钥验证，且签名规则仅排除 sign（保留 sign_type）', async () => {
    let capturedUrl = ''
    let capturedBody = ''
    const provider = new AlipayProvider({
      ...alipayConfig(),
      fetchImpl: async (url, init) => {
        capturedUrl = url
        capturedBody = String(init?.body)
        return new Response(
          JSON.stringify({ alipay_trade_precreate_response: { code: '10000', qr_code: 'x' } }),
          { status: 200 },
        )
      },
    })

    await provider.createPaymentIntent({ orderId: 'order-1', amountCny: 68, subject: 'Pro' })

    // 签名原文由 query 参数与 body 中的 biz_content 共同组成
    const query = new URL(capturedUrl).searchParams
    const bodyParams = new URLSearchParams(capturedBody)
    const merged = new URLSearchParams(query)
    for (const [key, value] of bodyParams.entries()) merged.set(key, value)

    const sign = merged.get('sign')!

    // 官方规则（自行实现签名）：仅排除 sign 与空值，sign_type 参与签名。
    // 注意与异步通知验签的区别：通知验签需同时排除 sign 与 sign_type。
    const entries: Array<[string, string]> = []
    for (const [key, value] of merged.entries()) {
      if (key === 'sign') continue
      if (!value) continue
      entries.push([key, value])
    }
    const content = entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')

    const verifier = createVerify('RSA-SHA256')
    verifier.update(content, 'utf8')
    expect(verifier.verify(merchantPublicKeyPem, sign, 'base64')).toBe(true)
  })

  test('业务返回码非 10000 时视为渠道拒绝', async () => {
    const provider = new AlipayProvider({
      ...alipayConfig(),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            alipay_trade_precreate_response: { code: '40004', sub_msg: '业务处理失败' },
          }),
          { status: 200 },
        ),
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Pro',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('channel_rejected')
      expect(outcome.detail).toContain('业务处理失败')
    }
  })

  test('凭据缺失时不发起请求', async () => {
    let called = false
    const provider = new AlipayProvider({
      ...alipayConfig(),
      privateKeyPem: '',
      fetchImpl: async () => {
        called = true
        return new Response('{}', { status: 200 })
      },
    })

    const outcome = await provider.createPaymentIntent({
      orderId: 'order-1', amountCny: 68, subject: 'Pro',
    })

    expect(outcome.ok).toBe(false)
    expect(called).toBe(false)
  })
})

describe('支付宝查单', () => {
  test('TRADE_SUCCESS 视为已支付', async () => {
    const provider = new AlipayProvider({
      ...alipayConfig(),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            alipay_trade_query_response: {
              code: '10000', trade_status: 'TRADE_SUCCESS',
              trade_no: 'alipay-txn-1', total_amount: '68.00',
            },
          }),
          { status: 200 },
        ),
    })

    const outcome = await provider.queryOrder('order-1')

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.paid).toBe(true)
      expect(outcome.providerTransactionId).toBe('alipay-txn-1')
      expect(outcome.amountCny).toBe(68)
    }
  })

  test('WAIT_BUYER_PAY 视为未支付', async () => {
    const provider = new AlipayProvider({
      ...alipayConfig(),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            alipay_trade_query_response: { code: '10000', trade_status: 'WAIT_BUYER_PAY' },
          }),
          { status: 200 },
        ),
    })

    const outcome = await provider.queryOrder('order-1')

    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.paid).toBe(false)
  })
})
