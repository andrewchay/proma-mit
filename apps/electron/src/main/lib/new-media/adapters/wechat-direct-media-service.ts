/**
 * 微信公众号素材上传（图片与缩略图）。
 *
 * 设计要点：
 * - 预检必须在出网之前完成：文件类型按魔数判断，不信任扩展名；大小上限按类型与模式区分。
 * - 内容 SHA-256 作为复用键：同账号、同类型、同模式、同内容直接复用已有 media_id，
 *   避免重复上传与重复计数。
 * - 临时素材有有效期，过期后不能复用，必须重新上传，但历史 media_id 仍保留以便追溯。
 * - 平台限制数值来自官方文档的某一时点快照，必须标注来源与核对时间；
 *   真实判定仍以平台返回的 errcode 为准。
 * - 上传失败不写业务库以外的任何东西，也不把凭据或文件内容写进错误信息。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { WechatMediaAsset, WechatMediaMode, WechatMediaType, WechatMediaUploadAttempt } from '@gravitas/shared'
import { PlatformAdapterError } from '../platform-adapter'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from '../new-media-sqlite-store'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { getFetchFn } from '../../proxy-fetch'
import { withWechatAccessToken, type WechatTokenDependencies } from './wechat-direct-token-service'

export const WECHAT_MEDIA_ASSET_KIND = 'wechat-media-asset'

const TEMPORARY_URL = 'https://api.weixin.qq.com/cgi-bin/media/upload'
const PERMANENT_URL = 'https://api.weixin.qq.com/cgi-bin/material/add_material'
const INLINE_URL = 'https://api.weixin.qq.com/cgi-bin/media/uploadimg'

const REQUEST_TIMEOUT_MS = 30_000
/** 临时素材平台有效期 3 天；保守按 2.5 天复用，避免边界失效。 */
const TEMPORARY_REUSE_WINDOW_MS = Math.round(2.5 * 24 * 60 * 60 * 1000)

/**
 * 平台限制快照。
 *
 * source 记为官方文档；verifiedAt 记录核对时间。任何数值在真机验收前都只是本地预检，
 * 不是对平台行为的断言。
 */
export const WECHAT_MEDIA_LIMITS_SOURCE = {
  verifiedAt: '2026-09',
  source: '微信公众平台素材接口文档（本地预检快照，需在真机验收时重新核对）',
} as const

export const WECHAT_MEDIA_LIMITS = {
  image: {
    temporary: { maxBytes: 10 * 1024 * 1024, formats: ['jpg', 'jpeg', 'png', 'gif', 'bmp'] },
    permanent: { maxBytes: 10 * 1024 * 1024, formats: ['jpg', 'jpeg', 'png', 'gif', 'bmp'] },
    inline: { maxBytes: 1 * 1024 * 1024, formats: ['jpg', 'jpeg', 'png', 'gif', 'bmp'] },
  },
  thumb: {
    // 缩略图只支持永久素材，且体积上限明显更小。
    permanent: { maxBytes: 64 * 1024, formats: ['jpg', 'jpeg', 'png', 'bmp'] },
  },
} as const satisfies Record<WechatMediaType, Partial<Record<WechatMediaMode, { maxBytes: number; formats: readonly string[] }>>>

export type WechatImageFormat = 'jpg' | 'png' | 'gif' | 'bmp'

/** 按魔数判断图片格式，不信任文件扩展名。 */
export function detectImageFormat(bytes: Uint8Array): WechatImageFormat | undefined {
  if (bytes.length < 4) return undefined
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'
  return undefined
}

export interface WechatMediaPrecheckInput {
  fileName: string
  bytes: Uint8Array
  type: WechatMediaType
  mode: WechatMediaMode
}

export interface WechatMediaPrecheckResult {
  ok: boolean
  problems: string[]
  format?: WechatImageFormat
  byteLength: number
  sha256: string
  maxBytes?: number
}

function limitsFor(type: WechatMediaType, mode: WechatMediaMode): { maxBytes: number; formats: readonly string[] } | undefined {
  return (WECHAT_MEDIA_LIMITS[type] as Partial<Record<WechatMediaMode, { maxBytes: number; formats: readonly string[] }>>)[mode]
}

/**
 * 出网前预检：类型/模式组合、魔数格式、大小上限。
 * 返回全部问题而不是只报第一个，便于 UI 一次讲清楚。
 */
export function precheckWechatMedia(input: WechatMediaPrecheckInput): WechatMediaPrecheckResult {
  const problems: string[] = []
  const byteLength = input.bytes.byteLength
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const limits = limitsFor(input.type, input.mode)

  if (limits === undefined) {
    const supported = Object.keys(WECHAT_MEDIA_LIMITS[input.type] ?? {}).join('、') || '无'
    problems.push(input.type === 'thumb'
      ? `缩略图只支持永久素材，当前模式为 ${input.mode}`
      : `该类型不支持 ${input.mode} 模式（支持：${supported}）`)
    return { ok: false, problems, byteLength, sha256 }
  }
  if (byteLength === 0) problems.push('素材内容为空')
  if (byteLength > limits.maxBytes) {
    problems.push(`素材体积 ${(byteLength / 1024 / 1024).toFixed(2)}MB 超出该类型上限 ${(limits.maxBytes / 1024 / 1024).toFixed(2)}MB`)
  }
  const format = detectImageFormat(input.bytes)
  if (!format) {
    problems.push('无法识别图片格式：仅支持 JPG、PNG、GIF、BMP')
  } else if (!limits.formats.includes(format)) {
    problems.push(`${format.toUpperCase()} 不被该类型与模式接受（支持：${limits.formats.join('、')}）`)
  }
  return { ok: problems.length === 0, problems, format, byteLength, sha256, maxBytes: limits.maxBytes }
}

export function mediaAssetKey(input: { accountId: string; type: WechatMediaType; mode: WechatMediaMode; sha256: string }): string {
  return `${input.accountId}:${input.type}:${input.mode}:${input.sha256}`
}

function base64Name(fileName: string): string {
  // multipart 文件名按 RFC 5987 用 UTF-8 百分号编码，避免中文名被截断。
  return encodeURIComponent(fileName)
}

/** 构造 multipart/form-data 请求体。字段名固定为 media，与微信接口一致。 */
export function buildMediaMultipart(input: { fileName: string; bytes: Uint8Array; boundary: string }): Uint8Array {
  const head = Buffer.from(
    `--${input.boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${base64Name(input.fileName)}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
    'utf-8',
  )
  const tail = Buffer.from(`\r\n--${input.boundary}--\r\n`, 'utf-8')
  return new Uint8Array(Buffer.concat([head, Buffer.from(input.bytes), tail]))
}

/**
 * 媒体服务依赖：token 与媒体使用各自独立的传输层，
 * 避免两者共用一个 `transport` 键造成误注入。
 */
export interface WechatMediaDependencies {
  mediaTransport?: WechatMediaTransport
  token?: WechatTokenDependencies
  now?: () => number
}

export interface WechatMediaTransportResponse {
  status: number
  text(): Promise<string>
}

export type WechatMediaTransport = (input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
}) => Promise<WechatMediaTransportResponse>

/** 平台 errcode → 本地可执行原因。 */
import type { PlatformAdapterErrorCode } from '../platform-adapter'

export const WECHAT_MEDIA_ERROR_CODES: Record<number, { code: PlatformAdapterErrorCode; message: string }> = {
  40004: { code: 'invalid_media_type', message: '平台不接受该素材类型，请核对类型与模式组合' },
  40005: { code: 'invalid_media_format', message: '平台不支持该文件格式' },
  40006: { code: 'invalid_media_size', message: '素材体积超出平台上限' },
  40007: { code: 'invalid_media_id', message: 'media_id 无效或已被平台删除' },
  41005: { code: 'invalid_media_format', message: '缺少或无法解析素材内容' },
  45001: { code: 'invalid_media_size', message: '素材体积超出平台上限' },
  48001: { code: 'insufficient_scope', message: '该账号没有素材接口权限' },
  45009: { code: 'temporarily_unavailable', message: '调用频率超限，请稍后重试' },
  '-1': { code: 'temporarily_unavailable', message: '微信侧系统繁忙，稍后重试' },
}

interface WechatMediaResponse {
  media_id?: string
  url?: string
  errcode?: number
  errmsg?: string
}

async function defaultTransport(input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
}): Promise<WechatMediaTransportResponse> {
  const proxyUrl = await getEffectiveProxyUrl()
  // fetch 的 BodyInit 不接受 Uint8Array，这里转成 ArrayBuffer 传递二进制体。
  const body = input.body.buffer.slice(input.body.byteOffset, input.body.byteOffset + input.body.byteLength) as ArrayBuffer
  const response = await getFetchFn(proxyUrl)(input.url, {
    method: input.method,
    headers: input.headers,
    body,
    signal: input.signal,
  })
  return { status: response.status, text: () => response.text() }
}

function endpointFor(type: WechatMediaType, mode: WechatMediaMode): string {
  if (mode === 'temporary') return `${TEMPORARY_URL}?type=${type}`
  if (mode === 'inline') return INLINE_URL
  return `${PERMANENT_URL}?type=${type}`
}

async function performUpload(input: {
  credentialRef: string
  accountId: string
  fileName: string
  bytes: Uint8Array
  type: WechatMediaType
  mode: WechatMediaMode
  dependencies: WechatMediaDependencies
}): Promise<{ mediaId?: string; url?: string }> {
  const transport = input.dependencies.mediaTransport ?? defaultTransport
  const boundary = `----gravitas${randomUUID().replace(/-/g, '')}`
  const body = buildMediaMultipart({ fileName: input.fileName, bytes: input.bytes, boundary })
  const endpoint = endpointFor(input.type, input.mode)

  return withWechatAccessToken(input.credentialRef, async (accessToken) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`
      const response = await transport({
        url,
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: controller.signal,
      })
      const raw = await response.text()
      let parsed: WechatMediaResponse
      try {
        parsed = JSON.parse(raw) as WechatMediaResponse
      } catch {
        throw new PlatformAdapterError('temporarily_unavailable', `微信返回了无法解析的响应（HTTP ${response.status}）`)
      }
      if (parsed.errcode && parsed.errcode !== 0) throw mediaError(parsed.errcode, parsed.errmsg)
      if (!parsed.media_id && !parsed.url) throw new PlatformAdapterError('temporarily_unavailable', '微信未返回 media_id 或 url，且未给出错误码')
      return { mediaId: parsed.media_id, url: parsed.url }
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PlatformAdapterError('temporarily_unavailable', `素材上传超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
      }
      throw new PlatformAdapterError('temporarily_unavailable', `素材上传失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }, input.dependencies.token ?? {})
}

function mediaError(errcode: number, errmsg?: string): PlatformAdapterError {
  const known = WECHAT_MEDIA_ERROR_CODES[errcode]
  if (known) {
    return new PlatformAdapterError(known.code, `${known.message}（errcode=${errcode}）`)
  }
  return new PlatformAdapterError('temporarily_unavailable', `微信返回未识别错误（errcode=${errcode}${errmsg ? `，errmsg=${errmsg}` : ''}）`)
}

function isTemporaryExpired(asset: WechatMediaAsset, now: number): boolean {
  if (asset.mode !== 'temporary') return false
  if (!asset.currentExpiresAt) return true
  return asset.currentExpiresAt - now <= 0
}

/** 可复用的素材：类型/模式/内容一致，且（临时素材）仍在复用窗口内。 */
export async function findReusableWechatMedia(input: {
  accountId: string
  type: WechatMediaType
  mode: WechatMediaMode
  sha256: string
  now?: number
}): Promise<WechatMediaAsset | undefined> {
  const now = input.now ?? Date.now()
  const assets = await listNewMediaRecords<WechatMediaAsset>(WECHAT_MEDIA_ASSET_KIND)
  const match = assets.find((asset) =>
    asset.accountId === input.accountId &&
    asset.type === input.type &&
    asset.mode === input.mode &&
    asset.sha256 === input.sha256)
  if (!match) return undefined
  if (!match.currentMediaId && !match.currentUrl) return undefined
  if (isTemporaryExpired(match, now)) return undefined
  if (input.mode === 'temporary' && match.currentExpiresAt && match.currentExpiresAt - now < TEMPORARY_REUSE_WINDOW_MS - 24 * 60 * 60 * 1000) return undefined
  return match
}

export interface EnsureWechatMediaInput {
  credentialRef: string
  accountId: string
  fileName: string
  bytes: Uint8Array
  type: WechatMediaType
  mode: WechatMediaMode
  /** 强制重新上传（用于平台已删除 media_id 的情况）。 */
  forceUpload?: boolean
  now?: number
  dependencies?: WechatMediaDependencies
}

export interface EnsureWechatMediaResult {
  asset: WechatMediaAsset
  /** true 表示复用了已有素材，没有出网。 */
  reused: boolean
}

/**
 * 保证素材可用：命中缓存则复用，否则预检后上传并记录血缘。
 */
export async function ensureWechatMedia(input: EnsureWechatMediaInput): Promise<EnsureWechatMediaResult> {
  if (!input.accountId.trim()) throw new Error('账号标识不能为空')
  const now = input.now ?? Date.now()
  const precheck = precheckWechatMedia({ fileName: input.fileName, bytes: input.bytes, type: input.type, mode: input.mode })
  if (!precheck.ok) {
    throw new PlatformAdapterError('invalid_media_format', `素材预检未通过：${precheck.problems.join('；')}`)
  }

  if (!input.forceUpload) {
    const reusable = await findReusableWechatMedia({ accountId: input.accountId, type: input.type, mode: input.mode, sha256: precheck.sha256, now })
    if (reusable) return { asset: reusable, reused: true }
  }

  const existing = (await listNewMediaRecords<WechatMediaAsset>(WECHAT_MEDIA_ASSET_KIND)).find((asset) =>
    mediaAssetKey({ accountId: asset.accountId, type: asset.type, mode: asset.mode, sha256: asset.sha256 }) ===
    mediaAssetKey({ accountId: input.accountId, type: input.type, mode: input.mode, sha256: precheck.sha256 }))

  let uploaded: { mediaId?: string; url?: string }
  let attempt: WechatMediaUploadAttempt
  try {
    uploaded = await performUpload({
      credentialRef: input.credentialRef,
      accountId: input.accountId,
      fileName: input.fileName,
      bytes: input.bytes,
      type: input.type,
      mode: input.mode,
      dependencies: input.dependencies ?? {},
    })
    attempt = {
      mediaId: uploaded.mediaId,
      url: uploaded.url,
      uploadedAt: now,
      expiresAt: input.mode === 'temporary' ? now + 3 * 24 * 60 * 60 * 1000 : undefined,
      status: 'uploaded',
    }
  } catch (error) {
    const errorCode = error instanceof PlatformAdapterError ? error.code : 'temporarily_unavailable'
    const failed: WechatMediaAsset = {
      id: existing?.id ?? randomUUID(),
      accountId: input.accountId,
      type: input.type,
      mode: input.mode,
      sha256: precheck.sha256,
      byteLength: precheck.byteLength,
      format: precheck.format ?? 'unknown',
      sourceFileName: input.fileName.replace(/\\/g, '/').split('/').pop() ?? input.fileName,
      currentMediaId: existing?.currentMediaId,
      currentUrl: existing?.currentUrl,
      currentExpiresAt: existing?.currentExpiresAt,
      uploads: [{ uploadedAt: now, status: 'failed' as const, errorCode }, ...(existing?.uploads ?? [])].slice(0, 5),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await putNewMediaRecord(WECHAT_MEDIA_ASSET_KIND, failed)
    throw error
  }

  const history = [attempt, ...(existing?.uploads ?? [])].slice(0, 5)
  const asset: WechatMediaAsset = {
    id: existing?.id ?? randomUUID(),
    accountId: input.accountId,
    type: input.type,
    mode: input.mode,
    sha256: precheck.sha256,
    byteLength: precheck.byteLength,
    format: precheck.format ?? 'unknown',
    // 只保留文件名，绝不写本地绝对路径。
    sourceFileName: input.fileName.replace(/\\/g, '/').split('/').pop() ?? input.fileName,
    currentMediaId: uploaded.mediaId,
    currentUrl: uploaded.url,
    currentExpiresAt: attempt.expiresAt,
    uploads: history,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  return { asset: await putNewMediaRecord(WECHAT_MEDIA_ASSET_KIND, asset), reused: false }
}

export async function listWechatMediaAssets(accountId?: string): Promise<WechatMediaAsset[]> {
  const assets = await listNewMediaRecords<WechatMediaAsset>(WECHAT_MEDIA_ASSET_KIND)
  const scoped = accountId ? assets.filter((asset) => asset.accountId === accountId) : assets
  return scoped.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function getWechatMediaAsset(id: string): Promise<WechatMediaAsset | undefined> {
  return getNewMediaRecord<WechatMediaAsset>(WECHAT_MEDIA_ASSET_KIND, id)
}
