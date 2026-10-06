import { createSign, randomBytes } from 'node:crypto'
import type { SubscriptionProvider } from '../db/subscription-store'

/**
 * 支付渠道下单与查单适配器。
 *
 * 设计边界：
 * - 本模块只负责「向渠道发起请求」与「解析渠道返回」
 * - 回调验签由 wechat-pay-signature.ts / alipay-signature.ts 负责，不由本模块承担
 * - 查单结果仅用于客户端展示与兜底触发，**不能直接据此发放权益**，
 *   权益发放必须经过回调验签或与渠道对账后的完整校验流程
 */

export interface PaymentIntentInput {
  orderId: string
  amountCny: number
  subject: string
}

export interface PaymentIntentResult {
  qrCodeContent?: string
  redirectUrl?: string
}

export type PaymentIntentFailureReason =
  | 'provider_not_configured'
  | 'channel_request_failed'
  | 'channel_rejected'
  | 'malformed_channel_response'

export type PaymentIntentOutcome =
  | { ok: true; result: PaymentIntentResult }
  | { ok: false; reason: PaymentIntentFailureReason; detail?: string }

export type OrderQueryOutcome =
  | { ok: true; paid: boolean; providerTransactionId?: string; amountCny?: number }
  | { ok: false; reason: PaymentIntentFailureReason; detail?: string }

export interface PaymentProvider {
  provider: SubscriptionProvider
  createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentOutcome>
  queryOrder(orderId: string): Promise<OrderQueryOutcome>
}

/** 可注入的 fetch，便于测试替换而无需真实网络 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface WechatPayProviderConfig {
  appId: string
  mchId: string
  apiV3Key: string
  privateKeyPem: string
  serialNo: string
  notifyUrl: string
  /** 微信支付 API 基址，便于测试替换 */
  apiBase?: string
  fetchImpl?: FetchLike
}

export interface AlipayProviderConfig {
  appId: string
  privateKeyPem: string
  alipayPublicKeyPem: string
  notifyUrl: string
  /** 支付宝网关地址，便于测试替换 */
  gatewayUrl?: string
  fetchImpl?: FetchLike
}

/** 微信支付 API v3 请求签名：使用商户私钥对 方法\nURL\ntimestamp\nnonce\nbody\n 签名 */
export function buildWechatRequestSignatureMessage(
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`
}

export function buildWechatAuthorizationHeader(params: {
  mchId: string
  serialNo: string
  nonce: string
  timestamp: string
  signature: string
}): string {
  return (
    `WECHATPAY2-SHA256-RSA2048 mchid="${params.mchId}",` +
    `nonce_str="${params.nonce}",` +
    `signature="${params.signature}",` +
    `timestamp="${params.timestamp}",` +
    `serial_no="${params.serialNo}"`
  )
}

/** 金额由元转分，渠道接口以分为单位 */
export function cnyToFen(amountCny: number): number {
  return Math.round(amountCny * 100)
}

export class WechatPayProvider implements PaymentProvider {
  readonly provider = 'wechat-pay' as const
  private readonly apiBase: string
  private readonly fetchImpl: FetchLike

  constructor(private readonly config: WechatPayProviderConfig) {
    this.apiBase = config.apiBase ?? 'https://api.mch.weixin.qq.com'
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** 判断凭据是否齐全，缺失时不应发起真实请求 */
  private isConfigured(): boolean {
    return Boolean(
      this.config.appId && this.config.mchId && this.config.privateKeyPem && this.config.serialNo,
    )
  }

  private signRequest(method: string, urlPath: string, body: string) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(16).toString('hex')
    const message = buildWechatRequestSignatureMessage(method, urlPath, timestamp, nonce, body)
    const signature = createSign('RSA-SHA256')
      .update(message, 'utf8')
      .sign(this.config.privateKeyPem, 'base64')
    return { timestamp, nonce, signature }
  }

  async createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentOutcome> {
    if (!this.isConfigured()) {
      return { ok: false, reason: 'provider_not_configured' }
    }

    const urlPath = '/v3/pay/transactions/native'
    const body = JSON.stringify({
      appid: this.config.appId,
      mchid: this.config.mchId,
      description: input.subject,
      out_trade_no: input.orderId,
      notify_url: this.config.notifyUrl,
      amount: { total: cnyToFen(input.amountCny), currency: 'CNY' },
    })

    const { timestamp, nonce, signature } = this.signRequest('POST', urlPath, body)

    try {
      const response = await this.fetchImpl(`${this.apiBase}${urlPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: buildWechatAuthorizationHeader({
            mchId: this.config.mchId,
            serialNo: this.config.serialNo,
            nonce,
            timestamp,
            signature,
          }),
        },
        body,
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return { ok: false, reason: 'channel_rejected', detail: detail.slice(0, 500) }
      }

      const json = (await response.json().catch(() => undefined)) as
        | { code_url?: string }
        | undefined
      if (!json?.code_url) {
        return { ok: false, reason: 'malformed_channel_response' }
      }

      return { ok: true, result: { qrCodeContent: json.code_url } }
    } catch (error) {
      return {
        ok: false,
        reason: 'channel_request_failed',
        detail: error instanceof Error ? error.message : 'unknown',
      }
    }
  }

  /**
   * 主动查单，用于回调丢失时的兜底。
   *
   * 返回的 paid 仅代表渠道侧状态，调用方不得直接据此发放权益，
   * 必须走与回调一致的校验流程。
   */
  async queryOrder(orderId: string): Promise<OrderQueryOutcome> {
    if (!this.isConfigured()) {
      return { ok: false, reason: 'provider_not_configured' }
    }

    const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(this.config.mchId)}`
    const { timestamp, nonce, signature } = this.signRequest('GET', urlPath, '')

    try {
      const response = await this.fetchImpl(`${this.apiBase}${urlPath}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: buildWechatAuthorizationHeader({
            mchId: this.config.mchId,
            serialNo: this.config.serialNo,
            nonce,
            timestamp,
            signature,
          }),
        },
      })

      if (!response.ok) {
        return { ok: false, reason: 'channel_rejected' }
      }

      const json = (await response.json().catch(() => undefined)) as
        | { trade_state?: string; transaction_id?: string; amount?: { total?: number } }
        | undefined
      if (!json?.trade_state) {
        return { ok: false, reason: 'malformed_channel_response' }
      }

      const totalFen = json.amount?.total
      return {
        ok: true,
        paid: json.trade_state === 'SUCCESS',
        ...(json.transaction_id ? { providerTransactionId: json.transaction_id } : {}),
        ...(typeof totalFen === 'number' ? { amountCny: totalFen / 100 } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'channel_request_failed',
        detail: error instanceof Error ? error.message : 'unknown',
      }
    }
  }
}

export class AlipayProvider implements PaymentProvider {
  readonly provider = 'alipay' as const
  private readonly gatewayUrl: string
  private readonly fetchImpl: FetchLike

  constructor(private readonly config: AlipayProviderConfig) {
    this.gatewayUrl = config.gatewayUrl ?? 'https://openapi.alipay.com/gateway.do'
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  private isConfigured(): boolean {
    return Boolean(this.config.appId && this.config.privateKeyPem)
  }

  /**
   * 构造支付宝请求。
   *
   * 官方要求：业务参数（biz_content）置于 HTTP body，
   * 其余平台参数置于 URL query。详见「自行实现签名」文档步骤 5。
   */
  private buildSignedRequest(
    method: string,
    bizContent: Record<string, unknown>,
  ): { url: string; body: string } {
    const params: Record<string, string> = {
      app_id: this.config.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: formatAlipayTimestamp(new Date()),
      version: '1.0',
      notify_url: this.config.notifyUrl,
      biz_content: JSON.stringify(bizContent),
    }

    // 签名原文：仅排除 sign 与空值，sign_type 参与签名
    const signContent = Object.keys(params)
      .filter((key) => key !== 'sign')
      .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&')

    const signature = createSign('RSA-SHA256')
      .update(signContent, 'utf8')
      .sign(this.config.privateKeyPem, 'base64')

    // 平台参数进 query，业务参数进 body
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (key === 'biz_content') continue
      query.set(key, value)
    }
    query.set('sign', signature)

    return {
      url: `${this.gatewayUrl}?${query.toString()}`,
      body: new URLSearchParams({ biz_content: params.biz_content }).toString(),
    }
  }

  async createPaymentIntent(input: PaymentIntentInput): Promise<PaymentIntentOutcome> {
    if (!this.isConfigured()) {
      return { ok: false, reason: 'provider_not_configured' }
    }

    const request = this.buildSignedRequest('alipay.trade.precreate', {
      out_trade_no: input.orderId,
      total_amount: input.amountCny.toFixed(2),
      subject: input.subject,
    })

    try {
      const response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: request.body,
      })

      if (!response.ok) {
        return { ok: false, reason: 'channel_rejected' }
      }

      const json = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
      const tradeResponse = json?.alipay_trade_precreate_response as
        | { code?: string; qr_code?: string; sub_msg?: string; msg?: string }
        | undefined

      if (tradeResponse?.code !== '10000') {
        return {
          ok: false,
          reason: 'channel_rejected',
          detail: tradeResponse?.sub_msg ?? tradeResponse?.msg ?? '',
        }
      }

      if (!tradeResponse.qr_code) {
        return { ok: false, reason: 'malformed_channel_response' }
      }

      return { ok: true, result: { qrCodeContent: tradeResponse.qr_code } }
    } catch (error) {
      return {
        ok: false,
        reason: 'channel_request_failed',
        detail: error instanceof Error ? error.message : 'unknown',
      }
    }
  }

  async queryOrder(orderId: string): Promise<OrderQueryOutcome> {
    if (!this.isConfigured()) {
      return { ok: false, reason: 'provider_not_configured' }
    }

    const request = this.buildSignedRequest('alipay.trade.query', { out_trade_no: orderId })

    try {
      const response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: request.body,
      })

      if (!response.ok) {
        return { ok: false, reason: 'channel_rejected' }
      }

      const json = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
      const queryResponse = json?.alipay_trade_query_response as
        | { code?: string; trade_status?: string; trade_no?: string; total_amount?: string }
        | undefined

      if (queryResponse?.code !== '10000') {
        return { ok: false, reason: 'channel_rejected' }
      }

      const tradeStatus = queryResponse.trade_status ?? ''
      const totalAmount = queryResponse.total_amount

      return {
        ok: true,
        paid: tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED',
        ...(queryResponse.trade_no ? { providerTransactionId: queryResponse.trade_no } : {}),
        ...(totalAmount ? { amountCny: Number(totalAmount) } : {}),
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'channel_request_failed',
        detail: error instanceof Error ? error.message : 'unknown',
      }
    }
  }
}

/** 支付宝要求 yyyy-MM-dd HH:mm:ss 格式 */
export function formatAlipayTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}
