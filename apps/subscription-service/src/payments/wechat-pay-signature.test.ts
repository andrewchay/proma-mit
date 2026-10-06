import { describe, expect, test, beforeAll } from 'bun:test'
import { generateKeyPairSync, createSign, createCipheriv, randomBytes } from 'node:crypto'
import {
  buildWechatSignatureMessage,
  verifyWechatCallbackSignature,
  decryptWechatResource,
  parseWechatCallback,
  WECHAT_CALLBACK_MAX_SKEW_MS,
} from './wechat-pay-signature'

// 用自生成密钥对模拟「微信支付平台证书」，不依赖任何真实凭据
let platformPrivateKeyPem: string
let platformPublicKeyPem: string
let apiV3Key: string

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  platformPrivateKeyPem = privateKey
  platformPublicKeyPem = publicKey
  apiV3Key = randomBytes(16).toString('hex').slice(0, 32)
})

/** 按微信规则用平台私钥签名，模拟微信侧发出的回调 */
function signAsWechat(timestamp: string, nonce: string, body: string): string {
  const message = buildWechatSignatureMessage(timestamp, nonce, body)
  return createSign('RSA-SHA256').update(message, 'utf8').sign(platformPrivateKeyPem, 'base64')
}

/** 用 APIv3 密钥以 AES-256-GCM 加密 resource，模拟微信侧的密文 */
function encryptResourceAsWechat(plaintext: string, associatedData: string, nonce: string): string {
  const key = Buffer.from(apiV3Key, 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'))
  cipher.setAAD(Buffer.from(associatedData, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([encrypted, authTag]).toString('base64')
}

describe('微信支付 v3 回调验签', () => {
  test('签名串按 timestamp\\nnonce\\nbody\\n 规则构造', () => {
    expect(buildWechatSignatureMessage('1700000000', 'abc123', '{"a":1}')).toBe(
      '1700000000\nabc123\n{"a":1}\n',
    )
  })

  test('合法签名通过验证', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'nonce-abc'
    const body = '{"id":"evt-1"}'
    const signature = signAsWechat(timestamp, nonce, body)

    const result = verifyWechatCallbackSignature({
      timestamp,
      nonce,
      body,
      signature,
      platformPublicKeyPem,
      now: Date.now(),
    })

    expect(result.ok).toBe(true)
  })

  test('篡改请求体后签名验证失败', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = 'nonce-abc'
    const signature = signAsWechat(timestamp, nonce, '{"amount":1}')

    const result = verifyWechatCallbackSignature({
      timestamp,
      nonce,
      body: '{"amount":999999}',
      signature,
      platformPublicKeyPem,
      now: Date.now(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature_mismatch')
  })

  test('时间戳超出容差窗口时拒绝，防止重放', () => {
    const timestamp = String(Math.floor((Date.now() - WECHAT_CALLBACK_MAX_SKEW_MS - 60000) / 1000))
    const nonce = 'nonce-old'
    const body = '{"id":"evt-old"}'
    const signature = signAsWechat(timestamp, nonce, body)

    const result = verifyWechatCallbackSignature({
      timestamp,
      nonce,
      body,
      signature,
      platformPublicKeyPem,
      now: Date.now(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('timestamp_out_of_tolerance')
  })

  test('缺少签名参数时拒绝', () => {
    const result = verifyWechatCallbackSignature({
      timestamp: '',
      nonce: '',
      body: '{}',
      signature: '',
      platformPublicKeyPem,
      now: Date.now(),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing_signature_params')
  })
})

describe('微信支付 v3 resource 解密', () => {
  test('正确密钥与 AAD 可以解出明文', () => {
    const plaintext = JSON.stringify({ out_trade_no: 'order-1', amount: { total: 6800 } })
    const associatedData = 'transaction'
    const nonce = 'nonce12bytes'
    const ciphertext = encryptResourceAsWechat(plaintext, associatedData, nonce)

    const result = decryptWechatResource({
      ciphertext,
      nonce,
      associatedData,
      apiV3Key,
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plaintext).toBe(plaintext)
  })

  test('AAD 不匹配时解密失败（认证标签校验）', () => {
    const ciphertext = encryptResourceAsWechat('{"a":1}', 'transaction', 'nonce12bytes')

    const result = decryptWechatResource({
      ciphertext,
      nonce: 'nonce12bytes',
      associatedData: 'wrong-aad',
      apiV3Key,
    })

    expect(result.ok).toBe(false)
  })

  test('密钥长度非法时明确报错', () => {
    const result = decryptWechatResource({
      ciphertext: 'AAAA',
      nonce: 'nonce12bytes',
      associatedData: 'transaction',
      apiV3Key: 'too-short',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('invalid_api_v3_key_length')
  })
})

describe('微信支付回调解析', () => {
  test('验签并解密后可取出订单号与金额', () => {
    const orderId = 'order-xyz'
    const amountTotal = 6800
    const transactionId = 'wx-txn-1'
    const resourcePlaintext = JSON.stringify({
      out_trade_no: orderId,
      transaction_id: transactionId,
      trade_state: 'SUCCESS',
      amount: { total: amountTotal, currency: 'CNY' },
    })
    const nonce = 'nonce12bytes'
    const associatedData = 'transaction'
    const encrypted = encryptResourceAsWechat(resourcePlaintext, associatedData, nonce)

    const timestamp = String(Math.floor(Date.now() / 1000))
    const callbackNonce = 'cb-nonce'
    const body = JSON.stringify({
      id: 'evt-1',
      event_type: 'TRANSACTION.SUCCESS',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: encrypted,
        nonce,
        associated_data: associatedData,
      },
    })
    const signature = signAsWechat(timestamp, callbackNonce, body)

    const result = parseWechatCallback({
      timestamp,
      nonce: callbackNonce,
      body,
      signature,
      platformPublicKeyPem,
      apiV3Key,
      now: Date.now(),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.orderId).toBe(orderId)
      expect(result.data.transactionId).toBe(transactionId)
      expect(result.data.amountTotalFen).toBe(amountTotal)
      expect(result.data.tradeState).toBe('SUCCESS')
    }
  })

  test('伪造 verified 字段无法绕过验签', () => {
    const timestamp = String(Date.now())
    const nonce = 'cb-nonce'
    // 攻击者构造：带 verified:true，但没有合法签名
    const body = JSON.stringify({
      verified: true,
      orderId: 'order-attack',
      transactionId: 'fake',
      amountCny: 0,
      resource: { ciphertext: 'AAAA', nonce: 'nonce12bytes', associated_data: 'transaction' },
    })

    const result = parseWechatCallback({
      timestamp,
      nonce,
      body,
      signature: 'ZmFrZQ==',
      platformPublicKeyPem,
      apiV3Key,
      now: Date.now(),
    })

    expect(result.ok).toBe(false)
  })
})
