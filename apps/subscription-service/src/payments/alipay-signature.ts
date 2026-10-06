import { createVerify } from 'node:crypto'

/**
 * 支付宝异步通知（notify）验签。
 *
 * 设计原则：与微信模块一致，不信任通知中的任何自述字段。
 * 只有支付宝公钥 RSA2 验签通过的参数才会被解析为业务数据。
 *
 * 验签规则（支付宝开放平台文档）：
 * 1. 剔除 sign 与 sign_type 字段
 * 2. 剔除空值字段
 * 3. 按参数名 ASCII 升序排列
 * 4. 以 key=value 形式用 & 拼接，不做 URL 编码
 */

/** 支付宝仅支持 RSA2（SHA256withRSA），RSA1 已不推荐且本服务不接受 */
const SUPPORTED_SIGN_TYPES = new Set(['RSA2'])

/** 视为已支付的交易状态 */
const PAID_TRADE_STATUSES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED'])

export function buildAlipaySignContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => {
      const value = params[key]
      return value !== undefined && value !== null && value !== ''
    })
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
}

export interface AlipayVerifyInput {
  params: Record<string, string>
  alipayPublicKeyPem: string
}

export type AlipayVerifyFailure =
  | 'missing_signature_params'
  | 'unsupported_sign_type'
  | 'signature_mismatch'
  | 'verify_error'

export type AlipayVerifyResult =
  | { ok: true }
  | { ok: false; reason: AlipayVerifyFailure }

export function verifyAlipaySignature(input: AlipayVerifyInput): AlipayVerifyResult {
  const { params, alipayPublicKeyPem } = input

  const sign = params.sign ?? ''
  const signType = params.sign_type ?? ''
  if (!sign || !signType || !alipayPublicKeyPem) {
    return { ok: false, reason: 'missing_signature_params' }
  }

  if (!SUPPORTED_SIGN_TYPES.has(signType)) {
    return { ok: false, reason: 'unsupported_sign_type' }
  }

  try {
    const content = buildAlipaySignContent(params)
    const verifier = createVerify('RSA-SHA256')
    verifier.update(content, 'utf8')
    const matched = verifier.verify(alipayPublicKeyPem, sign, 'base64')
    return matched ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
  } catch {
    return { ok: false, reason: 'verify_error' }
  }
}

export interface AlipayNotificationInput extends AlipayVerifyInput {}

export interface AlipayNotificationData {
  appId: string
  outTradeNo: string
  tradeNo: string
  totalAmount: string
  tradeStatus: string
  notifyId: string
  /** 由 tradeStatus 推导，调用方不必自己判断状态集合 */
  isPaid: boolean
}

export type AlipayNotificationResult =
  | { ok: true; data: AlipayNotificationData }
  | { ok: false; reason: AlipayVerifyFailure | 'malformed_notification' }

/**
 * 完整通知处理：先验签，再解析业务字段。
 * 任何一步失败都返回 ok:false，调用方不得据此发放权益。
 */
export function parseAlipayNotification(
  input: AlipayNotificationInput,
): AlipayNotificationResult {
  const signatureResult = verifyAlipaySignature(input)
  if (!signatureResult.ok) return { ok: false, reason: signatureResult.reason }

  const { params } = input
  const appId = params.app_id ?? ''
  const outTradeNo = params.out_trade_no ?? ''
  const tradeNo = params.trade_no ?? ''
  const totalAmount = params.total_amount ?? ''
  const tradeStatus = params.trade_status ?? ''
  const notifyId = params.notify_id ?? ''

  if (!outTradeNo || !tradeNo || !totalAmount || !tradeStatus) {
    return { ok: false, reason: 'malformed_notification' }
  }

  return {
    ok: true,
    data: {
      appId,
      outTradeNo,
      tradeNo,
      totalAmount,
      tradeStatus,
      notifyId,
      isPaid: PAID_TRADE_STATUSES.has(tradeStatus),
    },
  }
}
