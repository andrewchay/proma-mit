/**
 * 微信第三方平台授权事件接收回调。
 *
 * 处理两类请求（路由由 app.ts 挂载）：
 * - GET：URL 有效性验证（微信会带 signature/timestamp/nonce/echostr，验签并解密后原样返回明文）；
 * - POST：授权事件推送（XML 密文，当前只处理 component_verify_ticket）。
 *
 * 安全约定：
 * - 验签失败、解密失败、时间戳过期、nonce 重放一律拒绝；
 * - ticket 明文只进加密存储，不进日志、不进响应；
 * - 日志只包含组件 appid、ticket 指纹与布尔结果，保证可观测而不泄密。
 */
import { extractComponentVerifyTicket, extractXmlCdataField, decryptWechatMessage, verifyWechatCallbackSignature, type WechatCallbackCryptoMaterial } from './message-crypto'
import { ticketFingerprint, type WechatComponentTicketStore } from './ticket-store'

/** 回调时间戳允许的时钟偏移：微信每 10 分钟推一次 ticket，5 分钟窗口足够。 */
export const CALLBACK_FRESHNESS_MS = 5 * 60 * 1000

export interface WechatCallbackHandlerOptions {
  cryptoMaterial: WechatCallbackCryptoMaterial
  ticketStore: WechatComponentTicketStore
  /** 预期的组件 AppID；回调 XML 中的 AppId 与之不符时拒绝。 */
  expectedComponentAppId?: string
  /** P3-04：授权事件（authorized/updateauthorized/unauthorized）处理钩子；抛错不影响对微信返回 success。 */
  onAuthorizationEvent?: (event: { infoType: string; componentAppId: string; authorizerAppId?: string }) => Promise<void> | void
  logger?: { info(message: string): void; warn(message: string): void }
  now?: () => number
}

export interface WechatCallbackRequest {
  method: 'GET' | 'POST'
  query: URLSearchParams
  body?: string
}

function reject(message: string, status: 400 | 401 | 403): Response {
  // 响应体不含失败细节，细节只进日志（且不包含密钥/密文）。
  return new Response('fail', { status })
}

function info(options: WechatCallbackHandlerOptions, message: string): void {
  options.logger?.info(message)
}

function warn(options: WechatCallbackHandlerOptions, message: string): void {
  options.logger?.warn(message)
}

/** GET：URL 有效性验证。验签解密成功时必须原样返回明文 echostr。 */
export async function handleWechatCallbackVerification(input: WechatCallbackRequest & { options: WechatCallbackHandlerOptions }): Promise<Response> {
  const { options } = input
  const signature = input.query.get('msg_signature') ?? ''
  const timestamp = input.query.get('timestamp') ?? ''
  const nonce = input.query.get('nonce') ?? ''
  const echostr = input.query.get('echostr') ?? ''
  if (!signature || !timestamp || !nonce || !echostr) return reject('missing params', 400)

  if (!verifyWechatCallbackSignature({ token: options.cryptoMaterial.token, timestamp, nonce, encrypt: echostr, signature })) {
    warn(options, '[WeChat] 回调验证签名不符')
    return reject('invalid signature', 401)
  }
  try {
    const decrypted = decryptWechatMessage({ ...options.cryptoMaterial, encrypt: echostr })
    return new Response(decrypted.message, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  } catch (error) {
    warn(options, `[WeChat] 回调验证解密失败：${error instanceof Error ? error.message : String(error)}`)
    return reject('decrypt failed', 401)
  }
}

/** POST：授权事件推送。当前只处理 component_verify_ticket。 */
export async function handleWechatCallbackEvent(input: WechatCallbackRequest & { options: WechatCallbackHandlerOptions }): Promise<Response> {
  const { options } = input
  const now = options.now ?? Date.now
  const signature = input.query.get('msg_signature') ?? ''
  const timestamp = input.query.get('timestamp') ?? ''
  const nonce = input.query.get('nonce') ?? ''
  const body = input.body ?? ''

  if (!signature || !timestamp || !nonce || !body) return reject('missing params', 400)

  // 时间戳新鲜度：拒绝过期或未来时间戳，防止截获的旧请求重放。
  const timestampNumber = Number(timestamp)
  if (!Number.isFinite(timestampNumber)) return reject('invalid timestamp', 400)
  const skew = Math.abs(now() - timestampNumber * 1000)
  if (skew > CALLBACK_FRESHNESS_MS) {
    warn(options, `[WeChat] 回调时间戳超出新鲜度窗口（偏差 ${Math.round(skew / 1000)}s）`)
    return reject('stale timestamp', 401)
  }

  const encrypt = extractXmlCdataField(body, 'Encrypt')
  if (!encrypt) {
    warn(options, '[WeChat] 回调缺少 Encrypt 字段')
    return reject('missing encrypt', 400)
  }

  if (!verifyWechatCallbackSignature({ token: options.cryptoMaterial.token, timestamp, nonce, encrypt, signature })) {
    warn(options, '[WeChat] 授权事件签名不符')
    return reject('invalid signature', 401)
  }

  // 重放保护：同一 timestamp+nonce+encrypt 组合只接受一次。
  const replayKey = `${timestamp}:${nonce}:${ticketFingerprint(encrypt)}`
  if (!await options.ticketStore.acceptOnce(replayKey)) {
    warn(options, '[WeChat] 回调为重放请求，已拒绝')
    return reject('replayed request', 401)
  }

  let decryptedXml: string
  let appId: string | undefined
  try {
    const decrypted = decryptWechatMessage({ ...options.cryptoMaterial, encrypt })
    decryptedXml = decrypted.message
    if (options.expectedComponentAppId && decrypted.receiveId !== options.expectedComponentAppId) {
      warn(options, '[WeChat] 回调 receiveId 与预期组件不符')
      return reject('receive id mismatch', 403)
    }
    appId = extractXmlCdataField(decryptedXml, 'AppId')
    if (appId && options.expectedComponentAppId && appId !== options.expectedComponentAppId) {
      warn(options, '[WeChat] 回调 AppId 与预期组件不符')
      return reject('app id mismatch', 403)
    }
  } catch (error) {
    warn(options, `[WeChat] 授权事件解密失败：${error instanceof Error ? error.message : String(error)}`)
    return reject('decrypt failed', 401)
  }

  const ticket = extractComponentVerifyTicket(decryptedXml)
  if (!ticket) {
    // P3-04：授权/更新/取消授权事件转发给授权服务；未知类型忽略。返回 success 避免微信重推堆积。
    const infoType = extractXmlCdataField(decryptedXml, 'InfoType')
    if (infoType && ['authorized', 'updateauthorized', 'unauthorized'].includes(infoType) && options.onAuthorizationEvent) {
      const authorizerAppId = extractXmlCdataField(decryptedXml, 'AuthorizerAppid')
      try {
        await options.onAuthorizationEvent({ infoType, componentAppId: appId ?? '', authorizerAppId })
        info(options, `[WeChat] 授权事件已处理（infoType=${infoType}，authorizer=${authorizerAppId ?? '未知'}）`)
      } catch (error) {
        warn(options, `[WeChat] 授权事件处理失败（infoType=${infoType}）：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      info(options, `[WeChat] 收到非 ticket 授权事件，已忽略（appId=${appId ?? '未知'}）`)
    }
    return new Response('success', { status: 200 })
  }

  if (!appId) {
    warn(options, '[WeChat] ticket 事件缺少 AppId，无法归属组件')
    return reject('missing app id', 400)
  }

  try {
    await options.ticketStore.save({ componentAppId: appId, ticket, receivedAt: now() })
  } catch (error) {
    warn(options, `[WeChat] ticket 存储失败：${error instanceof Error ? error.message : String(error)}`)
    return new Response('fail', { status: 500 })
  }
  info(options, `[WeChat] 已接收 component_verify_ticket（appId=${appId}，指纹=${ticketFingerprint(ticket)}）`)
  return new Response('success', { status: 200 })
}

/** 统一入口：按方法分发；未匹配返回 404。 */
export async function handleWechatCallback(input: WechatCallbackRequest & { options: WechatCallbackHandlerOptions }): Promise<Response | undefined> {
  if (input.method === 'GET') return handleWechatCallbackVerification(input)
  if (input.method === 'POST') return handleWechatCallbackEvent(input)
  return undefined
}
