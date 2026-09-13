import { createDecipheriv, createVerify, timingSafeEqual } from 'node:crypto'

/**
 * 微信支付 API v3 回调验签与解密。
 *
 * 设计原则：本模块不信任回调请求体中的任何自述字段（例如 verified），
 * 一切结论都来自平台公钥验签与 APIv3 密钥解密结果。
 * 真实凭据（平台证书、商户私钥、APIv3 密钥）由部署环境注入，本模块只接收 PEM/密钥字符串。
 */

/** 回调时间戳容差，超出窗口一律拒绝，防止重放 */
export const WECHAT_CALLBACK_MAX_SKEW_MS = 5 * 60 * 1000

export interface WechatSignatureInput {
  timestamp: string
  nonce: string
  body: string
  signature: string
  platformPublicKeyPem: string
  /** 便于测试注入的当前时间 */
  now?: number
}

export type WechatSignatureFailure =
  | 'missing_signature_params'
  | 'timestamp_invalid'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'
  | 'verify_error'

export type WechatSignatureResult =
  | { ok: true }
  | { ok: false; reason: WechatSignatureFailure }

/**
 * 微信签名串规则：timestamp\nnonce\nbody\n
 * 见微信支付 API v3 签名验证文档。
 */
export function buildWechatSignatureMessage(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}\n${nonce}\n${body}\n`
}

export function verifyWechatCallbackSignature(input: WechatSignatureInput): WechatSignatureResult {
  const { timestamp, nonce, body, signature, platformPublicKeyPem } = input

  if (!timestamp || !nonce || !body || !signature || !platformPublicKeyPem) {
    return { ok: false, reason: 'missing_signature_params' }
  }

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, reason: 'timestamp_invalid' }
  }

  const now = input.now ?? Date.now()
  const skullMs = Math.abs(now - timestampSeconds * 1000)
  if (skullMs > WECHAT_CALLBACK_MAX_SKEW_MS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }

  try {
    const message = buildWechatSignatureMessage(timestamp, nonce, body)
    const verifier = createVerify('RSA-SHA256')
    verifier.update(message, 'utf8')
    const matched = verifier.verify(platformPublicKeyPem, signature, 'base64')
    return matched ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
  } catch {
    return { ok: false, reason: 'verify_error' }
  }
}

export interface WechatDecryptInput {
  ciphertext: string
  nonce: string
  associatedData: string
  apiV3Key: string
}

export type WechatDecryptFailure =
  | 'invalid_api_v3_key_length'
  | 'invalid_nonce_length'
  | 'decrypt_error'

export type WechatDecryptResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: WechatDecryptFailure }

/**
 * 解密回调 resource：AEAD_AES_256_GCM。
 * authTag 位于密文末尾 16 字节。
 */
export function decryptWechatResource(input: WechatDecryptInput): WechatDecryptResult {
  const { ciphertext, nonce, associatedData, apiV3Key } = input

  const keyBuffer = Buffer.from(apiV3Key, 'utf8')
  if (keyBuffer.length !== 32) {
    return { ok: false, reason: 'invalid_api_v3_key_length' }
  }

  const nonceBuffer = Buffer.from(nonce, 'utf8')
  if (nonceBuffer.length !== 12) {
    return { ok: false, reason: 'invalid_nonce_length' }
  }

  try {
    const data = Buffer.from(ciphertext, 'base64')
    if (data.length <= 16) return { ok: false, reason: 'decrypt_error' }

    const authTag = data.subarray(data.length - 16)
    const encrypted = data.subarray(0, data.length - 16)

    const decipher = createDecipheriv('aes-256-gcm', keyBuffer, nonceBuffer)
    decipher.setAuthTag(authTag)
    decipher.setAAD(Buffer.from(associatedData, 'utf8'))

    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    return { ok: true, plaintext }
  } catch {
    return { ok: false, reason: 'decrypt_error' }
  }
}

export interface WechatCallbackInput extends WechatSignatureInput {
  apiV3Key: string
}

export interface WechatCallbackData {
  orderId: string
  transactionId: string
  /** 金额，单位分 */
  amountTotalFen: number
  tradeState: string
  eventType: string
}

export type WechatCallbackResult =
  | { ok: true; data: WechatCallbackData }
  | { ok: false; reason: WechatSignatureFailure | WechatDecryptFailure | 'malformed_callback' }

/**
 * 完整回调处理：先验签，再解密，最后解析业务字段。
 * 任何一步失败都返回 ok:false，调用方不得据此发放权益。
 */
export function parseWechatCallback(input: WechatCallbackInput): WechatCallbackResult {
  const signatureResult = verifyWechatCallbackSignature(input)
  if (!signatureResult.ok) return { ok: false, reason: signatureResult.reason }

  let envelope: unknown
  try {
    envelope = JSON.parse(input.body)
  } catch {
    return { ok: false, reason: 'malformed_callback' }
  }

  if (typeof envelope !== 'object' || envelope === null) {
    return { ok: false, reason: 'malformed_callback' }
  }

  const node = envelope as Record<string, unknown>
  const eventType = typeof node.event_type === 'string' ? node.event_type : ''
  const resource = node.resource
  if (typeof resource !== 'object' || resource === null) {
    return { ok: false, reason: 'malformed_callback' }
  }

  const resourceNode = resource as Record<string, unknown>
  const ciphertext = typeof resourceNode.ciphertext === 'string' ? resourceNode.ciphertext : ''
  const resourceNonce = typeof resourceNode.nonce === 'string' ? resourceNode.nonce : ''
  const associatedData =
    typeof resourceNode.associated_data === 'string' ? resourceNode.associated_data : ''

  if (!ciphertext || !resourceNonce) {
    return { ok: false, reason: 'malformed_callback' }
  }

  const decrypted = decryptWechatResource({
    ciphertext,
    nonce: resourceNonce,
    associatedData,
    apiV3Key: input.apiV3Key,
  })
  if (!decrypted.ok) return { ok: false, reason: decrypted.reason }

  let payload: unknown
  try {
    payload = JSON.parse(decrypted.plaintext)
  } catch {
    return { ok: false, reason: 'malformed_callback' }
  }

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'malformed_callback' }
  }

  const payloadNode = payload as Record<string, unknown>
  const orderId = typeof payloadNode.out_trade_no === 'string' ? payloadNode.out_trade_no : ''
  const transactionId =
    typeof payloadNode.transaction_id === 'string' ? payloadNode.transaction_id : ''
  const tradeState = typeof payloadNode.trade_state === 'string' ? payloadNode.trade_state : ''

  const amount = payloadNode.amount
  const amountTotalFen =
    typeof amount === 'object' && amount !== null && typeof (amount as Record<string, unknown>).total === 'number'
      ? ((amount as Record<string, unknown>).total as number)
      : -1

  if (!orderId || !transactionId || amountTotalFen < 0) {
    return { ok: false, reason: 'malformed_callback' }
  }

  return {
    ok: true,
    data: { orderId, transactionId, amountTotalFen, tradeState, eventType },
  }
}

/** 恒定时间比较字符串，避免时序侧信道 */
export function safeStringEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
