import { describe, expect, test, beforeAll } from 'bun:test'
import { generateKeyPairSync, createSign } from 'node:crypto'
import {
  buildAlipaySignContent,
  verifyAlipaySignature,
  parseAlipayNotification,
} from './alipay-signature'

// 用自生成密钥对模拟「支付宝公钥」，不依赖任何真实凭据
let alipayPrivateKeyPem: string
let alipayPublicKeyPem: string

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  alipayPrivateKeyPem = privateKey
  alipayPublicKeyPem = publicKey
})

/** 按支付宝规则对参数签名，模拟支付宝侧发出的异步通知 */
function signAsAlipay(params: Record<string, string>): string {
  const content = buildAlipaySignContent(params)
  return createSign('RSA-SHA256').update(content, 'utf8').sign(alipayPrivateKeyPem, 'base64')
}

/** 构造一个合法的成功支付通知 */
function makeSuccessNotification(overrides: Record<string, string> = {}) {
  const params: Record<string, string> = {
    app_id: 'app-123',
    out_trade_no: 'order-1',
    trade_no: 'alipay-txn-1',
    trade_status: 'TRADE_SUCCESS',
    total_amount: '680.00',
    notify_id: 'notify-1',
    notify_time: '2026-09-13 08:00:00',
    ...overrides,
  }
  params.sign_type = 'RSA2'
  params.sign = signAsAlipay(params)
  return params
}

describe('支付宝验签串构造', () => {
  test('剔除 sign 与 sign_type，并按参数名升序拼接', () => {
    const content = buildAlipaySignContent({
      b: '2',
      a: '1',
      sign: 'should-be-removed',
      sign_type: 'RSA2',
    })
    expect(content).toBe('a=1&b=2')
  })

  test('跳过空值参数', () => {
    const content = buildAlipaySignContent({ a: '1', empty: '', b: '2' })
    expect(content).toBe('a=1&b=2')
  })
})

describe('支付宝异步通知验签', () => {
  test('合法签名通过验证', () => {
    const params = makeSuccessNotification()
    const result = verifyAlipaySignature({ params, alipayPublicKeyPem })
    expect(result.ok).toBe(true)
  })

  test('篡改金额后验签失败', () => {
    const params = makeSuccessNotification()
    params.total_amount = '0.01'
    const result = verifyAlipaySignature({ params, alipayPublicKeyPem })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_mismatch')
  })

  test('缺少签名时拒绝', () => {
    const params = makeSuccessNotification()
    delete params.sign
    const result = verifyAlipaySignature({ params, alipayPublicKeyPem })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_signature_params')
  })

  test('sign_type 非 RSA2 时拒绝', () => {
    const params = makeSuccessNotification({})
    params.sign_type = 'RSA'
    const result = verifyAlipaySignature({ params, alipayPublicKeyPem })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('unsupported_sign_type')
  })
})

describe('支付宝通知解析', () => {
  test('验签后可取出订单号、流水号与金额', () => {
    const params = makeSuccessNotification()
    const result = parseAlipayNotification({ params, alipayPublicKeyPem })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.outTradeNo).toBe('order-1')
      expect(result.data.tradeNo).toBe('alipay-txn-1')
      expect(result.data.totalAmount).toBe('680.00')
      expect(result.data.tradeStatus).toBe('TRADE_SUCCESS')
      expect(result.data.appId).toBe('app-123')
      expect(result.data.notifyId).toBe('notify-1')
    }
  })

  test('伪造 verified 字段无法绕过验签', () => {
    const result = parseAlipayNotification({
      params: {
        verified: 'true',
        out_trade_no: 'order-attack',
        trade_no: 'fake',
        total_amount: '0.01',
        trade_status: 'TRADE_SUCCESS',
        sign_type: 'RSA2',
        sign: 'ZmFrZQ==',
      },
      alipayPublicKeyPem,
    })

    expect(result.ok).toBe(false)
  })

  test('trade_status 非成功状态时解析结果标记为未完成', () => {
    const params = makeSuccessNotification({ trade_status: 'WAIT_BUYER_PAY' })
    // 重新签名，使签名覆盖新的 trade_status
    params.sign = signAsAlipay(params)

    const result = parseAlipayNotification({ params, alipayPublicKeyPem })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.tradeStatus).toBe('WAIT_BUYER_PAY')
      expect(result.data.isPaid).toBe(false)
    }
  })

  test('TRADE_SUCCESS 与 TRADE_FINISHED 都视为已支付', () => {
    for (const status of ['TRADE_SUCCESS', 'TRADE_FINISHED']) {
      const params = makeSuccessNotification({ trade_status: status })
      params.sign = signAsAlipay(params)
      const result = parseAlipayNotification({ params, alipayPublicKeyPem })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.isPaid).toBe(true)
    }
  })

  test('缺少必填字段时解析失败', () => {
    const params = makeSuccessNotification()
    delete params.out_trade_no
    params.sign = signAsAlipay(params)

    const result = parseAlipayNotification({ params, alipayPublicKeyPem })
    expect(result.ok).toBe(false)
  })
})
