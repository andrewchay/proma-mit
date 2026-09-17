/**
 * 微信公众号 stable token 获取与刷新。
 *
 * 关键约束：
 * - 凭据只从主进程加密 Secret Store 读取，token 也只写回该 Store，不进入业务数据库、日志或审计。
 * - 并发刷新必须合并为一次网络请求（single-flight），避免触发微信侧的刷新频率限制。
 * - 微信以 HTTP 200 + errcode 返回错误，必须解析 errcode 才能给出可诊断原因；
 *   出口 IP 未加白名单（40164/41001 等）要单独识别，并明确提示去微信后台配置。
 * - 网络请求统一走应用代理设置，与其它 Provider 调用保持一致。
 *
 * 本模块不做任何业务写入（草稿、发布、统计），只负责 token 生命周期。
 */
import { PlatformAdapterError } from '../platform-adapter'
import { saveNewMediaAccountSecret } from '../new-media-account-secret-store'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { getFetchFn } from '../../proxy-fetch'
import { loadWechatDirectCredential, type WechatDirectAuthorizationMaterial } from './wechat-direct-credential'

export const WECHAT_STABLE_TOKEN_ENDPOINT = 'https://api.weixin.qq.com/cgi-bin/stable_token'

/** 提前 5 分钟视为过期，避免边界时刻拿着即将失效的 token 出网。 */
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000
/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 15_000

export interface WechatTokenTransportResponse {
  status: number
  text(): Promise<string>
}

/** 可注入的传输层，便于在没有网络的测试里验证全部错误分支。 */
export type WechatTokenTransport = (input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}) => Promise<WechatTokenTransportResponse>

export interface WechatTokenDependencies {
  transport?: WechatTokenTransport
  now?: () => number
}

export interface WechatAccessToken {
  accessToken: string
  expiresAt: number
  /** true 表示本次是真实出网换取，false 表示命中缓存。 */
  refreshed: boolean
}

export interface WechatTokenFailure {
  errcode?: number
  errmsg?: string
}

/** 微信错误码 → 本地可诊断原因。 */
export const WECHAT_TOKEN_ERROR_CODES = {
  /** 出口 IP 不在白名单 */
  40164: { code: 'ip_not_whitelisted', message: '当前出口 IP 不在微信 IP 白名单中，请在微信后台「基本配置」中添加该 IP' },
  /** 非法的 IP 或 IP 不在白名单（旧码） */
  41001: { code: 'ip_not_whitelisted', message: '当前出口 IP 不被微信接受，请检查 IP 白名单配置' },
  /** 无效的 AppID */
  40013: { code: 'invalid_credentials', message: 'AppID 无效，请核对公众号 AppID' },
  /** 无效的 AppSecret */
  40125: { code: 'invalid_credentials', message: 'AppSecret 无效，请在微信后台重置后重新录入' },
  /** 系统繁忙 */
  '-1': { code: 'temporarily_unavailable', message: '微信侧系统繁忙，稍后重试即可；本地不会反复重试' },
  /** 调用频率超限 */
  45009: { code: 'temporarily_unavailable', message: '调用频率超限，请降低刷新频率后再试' },
  /** access_token 失效 */
  40001: { code: 'expired', message: 'access_token 已失效，需要用 force_refresh 重新获取' },
} as const

type WechatTokenErrorCode = 'invalid_credentials' | 'expired' | 'insufficient_scope' | 'temporarily_unavailable' | 'authorization_unavailable' | 'ip_not_whitelisted'

function platformError(code: WechatTokenErrorCode, message: string): PlatformAdapterError {
  return new PlatformAdapterError(code, message)
}

function mapWechatError(failure: WechatTokenFailure): PlatformAdapterError {
  const errcode = failure.errcode
  if (errcode !== undefined) {
    const known = (WECHAT_TOKEN_ERROR_CODES as Record<string, { code: string; message: string }>)[String(errcode)]
    if (known) {
      return platformError(known.code as WechatTokenErrorCode, `${known.message}（errcode=${errcode}）`)
    }
  }
  // 未识别的错误码只回传码值本身，绝不回显 token 或请求体。
  return platformError('temporarily_unavailable', `微信返回未识别错误（errcode=${errcode ?? '未知'}${failure.errmsg ? `，errmsg=${failure.errmsg}` : ''}）`)
}

function isUsable(token: WechatAccessToken | undefined, now: number): token is WechatAccessToken {
  if (!token || !token.accessToken) return false
  return token.expiresAt - EXPIRY_SAFETY_MARGIN_MS > now
}

/** 主进程内单飞表：同一账号的并发刷新只出网一次。 */
const inFlight = new Map<string, Promise<WechatAccessToken>>()

export function clearWechatTokenCache(): void {
  inFlight.clear()
}

export function getWechatTokenInFlightCount(): number {
  return inFlight.size
}

function readCachedToken(credentialRef: string, now: number): WechatAccessToken | undefined {
  const material = loadWechatDirectCredential(credentialRef)
  if (!material?.accessToken) return undefined
  const token: WechatAccessToken = { accessToken: material.accessToken, expiresAt: material.expiresAt ?? 0, refreshed: false }
  return isUsable(token, now) ? token : undefined
}

async function defaultTransport(input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}): Promise<WechatTokenTransportResponse> {
  const proxyUrl = await getEffectiveProxyUrl()
  const response = await getFetchFn(proxyUrl)(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal,
  })
  return { status: response.status, text: () => response.text() }
}

interface StableTokenResponse {
  access_token?: string
  expires_in?: number
  errcode?: number
  errmsg?: string
}

async function requestStableToken(
  material: WechatDirectAuthorizationMaterial,
  credentialRef: string,
  dependencies: WechatTokenDependencies,
): Promise<WechatAccessToken> {
  const transport = dependencies.transport ?? defaultTransport
  const now = dependencies.now ?? Date.now
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    // force_refresh: false —— 让微信在自身缓存有效时直接返回，减少刷新次数。
    const body = JSON.stringify({ grant_type: 'client_credential', appid: material.appId, secret: material.appSecret, force_refresh: false })
    const response = await transport({
      url: WECHAT_STABLE_TOKEN_ENDPOINT,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    })
    const raw = await response.text()
    let parsed: StableTokenResponse
    try {
      parsed = JSON.parse(raw) as StableTokenResponse
    } catch {
      // 不把响应正文写进错误，避免意外泄露。
      throw platformError('temporarily_unavailable', `微信返回了无法解析的响应（HTTP ${response.status}）`)
    }
    if (parsed.errcode && parsed.errcode !== 0) throw mapWechatError({ errcode: parsed.errcode, errmsg: parsed.errmsg })
    if (!parsed.access_token) throw platformError('temporarily_unavailable', '微信未返回 access_token，且未给出错误码')
    const expiresIn = Number(parsed.expires_in ?? 0)
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw platformError('temporarily_unavailable', '微信返回的 expires_in 无效')

    const token: WechatAccessToken = {
      accessToken: parsed.access_token,
      expiresAt: now() + expiresIn * 1000,
      refreshed: true,
    }
    // token 与过期时间写回加密 Store；这里不写业务数据库，也不写日志。
    saveNewMediaAccountSecret(credentialRef, { ...material, accessToken: token.accessToken, expiresAt: token.expiresAt })
    return token
  } catch (error) {
    if (error instanceof PlatformAdapterError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw platformError('temporarily_unavailable', `微信 token 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
    }
    throw platformError('temporarily_unavailable', `微信 token 请求失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 获取可用 access_token。
 * @param forceRefresh 强制刷新（用于微信返回 40001 时的重试）。
 */
export async function getWechatAccessToken(
  credentialRef: string,
  options: { forceRefresh?: boolean; dependencies?: WechatTokenDependencies } = {},
): Promise<WechatAccessToken> {
  if (!credentialRef.trim()) throw new Error('凭据引用不能为空')
  const dependencies = options.dependencies ?? {}
  const now = (dependencies.now ?? Date.now)()

  if (!options.forceRefresh) {
    const cached = readCachedToken(credentialRef, now)
    if (cached) return cached
  }

  const existing = inFlight.get(credentialRef)
  if (existing && !options.forceRefresh) return existing

  const pending = (async () => {
    const material = loadWechatDirectCredential(credentialRef)
    if (!material) throw platformError('authorization_unavailable', '账号授权材料缺失或未配置 AppSecret，请重新录入凭据')
    return requestStableToken(material, credentialRef, dependencies)
  })()
  inFlight.set(credentialRef, pending)
  try {
    return await pending
  } finally {
    if (inFlight.get(credentialRef) === pending) inFlight.delete(credentialRef)
  }
}

const REFRESH_RETRY_CODES = new Set([40001, 42001])

/**
 * 带一次强制刷新重试的调用包装。
 *
 * 微信在 token 意外失效时返回 40001/42001；这里只重试一次，
 * 且重试前会走 force_refresh，避免把失效 token 反复拿去调用。
 */
export async function withWechatAccessToken<T>(
  credentialRef: string,
  call: (accessToken: string) => Promise<T>,
  dependencies: WechatTokenDependencies = {},
): Promise<T> {
  const first = await getWechatAccessToken(credentialRef, { dependencies })
  try {
    return await call(first.accessToken)
  } catch (error) {
    if (!(error instanceof WechatApiCallError) || !REFRESH_RETRY_CODES.has(error.errcode)) throw error
    const refreshed = await getWechatAccessToken(credentialRef, { forceRefresh: true, dependencies })
    return call(refreshed.accessToken)
  }
}

/** 微信业务接口返回的错误，携带 errcode 供上层决定是否刷新 token。 */
export class WechatApiCallError extends Error {
  constructor(readonly errcode: number, readonly errmsg: string, readonly endpoint: string) {
    super(`微信接口调用失败：errcode=${errcode}${errmsg ? `，errmsg=${errmsg}` : ''}（${endpoint}）`)
    this.name = 'WechatApiCallError'
  }
}
