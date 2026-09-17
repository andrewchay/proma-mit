/**
 * 微信公众号草稿增改查删。
 *
 * 关键设计：
 * - 本地草稿记录里保存平台 media_id，形成稳定映射；未同步成功的草稿只存在于本地。
 * - 更新前先与平台比对：如果平台侧的更新时间与我们上次同步记录不一致，
 *   说明有人在公众号后台改过，本地更新必须被拒绝（update_conflict），
 *   由用户显式选择强制覆盖或放弃，绝不静默覆盖他人修改。
 * - 删除失败可恢复：失败时保留 media_id 与错误码并标记 delete_failed；
 *   若平台已判定 media_id 不存在（40007），则视为已删除（幂等恢复）。
 * - 草稿只存在微信草稿箱，未发布前对外不可见，因此这些操作都不属于「发布」。
 */
import { randomUUID } from 'node:crypto'
import type { WechatDraftArticle, WechatDraftRecord } from '@gravitas/shared'
import { PlatformAdapterError } from '../platform-adapter'
import { getNewMediaRecord, listNewMediaRecords, putNewMediaRecord } from '../new-media-sqlite-store'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { getFetchFn } from '../../proxy-fetch'
import { withWechatAccessToken, type WechatTokenDependencies } from './wechat-direct-token-service'

export const WECHAT_DRAFT_KIND = 'wechat-draft'

const DRAFT_ADD_URL = 'https://api.weixin.qq.com/cgi-bin/draft/add'
const DRAFT_UPDATE_URL = 'https://api.weixin.qq.com/cgi-bin/draft/update'
const DRAFT_GET_URL = 'https://api.weixin.qq.com/cgi-bin/draft/get'
const DRAFT_DELETE_URL = 'https://api.weixin.qq.com/cgi-bin/draft/delete'

const REQUEST_TIMEOUT_MS = 20_000

/**
 * 本地校验快照（非平台承诺）。
 * 数值来自官方草稿接口文档的某一时点，需在真机验收时重新核对。
 */
export const WECHAT_DRAFT_LIMITS = {
  verifiedAt: '2026-09',
  source: '微信公众平台草稿箱接口文档（本地预检快照，需在真机验收时重新核对）',
  maxArticles: 8,
  titleMaxChars: 64,
  authorMaxChars: 8,
  digestMaxChars: 120,
  contentMaxChars: 20_000,
  urlMaxChars: 512,
} as const

export interface WechatDraftPrecheckResult {
  ok: boolean
  problems: string[]
}

/** 出网前校验草稿结构。一次返回全部问题。 */
export function precheckWechatDraftArticles(articles: WechatDraftArticle[]): WechatDraftPrecheckResult {
  const problems: string[] = []
  if (!Array.isArray(articles) || articles.length === 0) {
    return { ok: false, problems: ['草稿至少需要一篇图文'] }
  }
  if (articles.length > WECHAT_DRAFT_LIMITS.maxArticles) {
    problems.push(`单次草稿最多 ${WECHAT_DRAFT_LIMITS.maxArticles} 篇图文，当前 ${articles.length} 篇`)
  }
  articles.forEach((article, index) => {
    const position = `第 ${index + 1} 篇`
    const title = article.title?.trim() ?? ''
    if (!title) problems.push(`${position}缺少标题`)
    else if (title.length > WECHAT_DRAFT_LIMITS.titleMaxChars) problems.push(`${position}标题超过 ${WECHAT_DRAFT_LIMITS.titleMaxChars} 字`)
    if (article.author && article.author.length > WECHAT_DRAFT_LIMITS.authorMaxChars) problems.push(`${position}作者名超过 ${WECHAT_DRAFT_LIMITS.authorMaxChars} 字`)
    if (article.digest && article.digest.length > WECHAT_DRAFT_LIMITS.digestMaxChars) problems.push(`${position}摘要超过 ${WECHAT_DRAFT_LIMITS.digestMaxChars} 字`)
    const content = article.content?.trim() ?? ''
    if (!content) problems.push(`${position}正文为空`)
    else if (content.length > WECHAT_DRAFT_LIMITS.contentMaxChars) problems.push(`${position}正文超过 ${WECHAT_DRAFT_LIMITS.contentMaxChars} 字`)
    // 平台会清洗脚本，但本地先拒绝，避免用户以为脚本会生效。
    if (/<script[\s>]/i.test(content)) problems.push(`${position}正文包含 <script>，平台会清洗且不应依赖脚本`)
    if (article.contentSourceUrl && article.contentSourceUrl.length > WECHAT_DRAFT_LIMITS.urlMaxChars) problems.push(`${position}原文链接过长`)
    if (article.contentSourceUrl && !/^https?:\/\//i.test(article.contentSourceUrl)) problems.push(`${position}原文链接必须是 http 或 https`)
    if (!article.thumbMediaId) problems.push(`${position}缺少封面素材 media_id，需先上传素材`)
  })
  return { ok: problems.length === 0, problems }
}

export interface WechatDraftTransportResponse {
  status: number
  text(): Promise<string>
}

export type WechatDraftTransport = (input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}) => Promise<WechatDraftTransportResponse>

export interface WechatDraftDependencies {
  draftTransport?: WechatDraftTransport
  token?: WechatTokenDependencies
  now?: () => number
}

export interface WechatDraftPlatformData {
  mediaId: string
  articles: WechatDraftArticle[]
  updateTime?: number
}

export const WECHAT_DRAFT_ERROR_CODES: Record<number, { code: string; message: string; recoverable: boolean }> = {
  40007: { code: 'invalid_media_id', message: '草稿 media_id 不存在，可能已在公众号后台删除', recoverable: true },
  45009: { code: 'temporarily_unavailable', message: '调用频率超限，请稍后重试', recoverable: true },
  45001: { code: 'invalid_media_size', message: '草稿内容超出平台上限', recoverable: false },
  48001: { code: 'insufficient_scope', message: '该账号没有草稿箱接口权限', recoverable: false },
  53500: { code: 'invalid_media_id', message: '草稿 media_id 无效', recoverable: true },
  53501: { code: 'invalid_media_id', message: '草稿不属于当前账号', recoverable: false },
  '-1': { code: 'temporarily_unavailable', message: '微信侧系统繁忙，稍后重试', recoverable: true },
}

function draftError(errcode: number, errmsg?: string): PlatformAdapterError & { recoverable: boolean } {
  const known = WECHAT_DRAFT_ERROR_CODES[errcode]
  const error = new PlatformAdapterError(
    (known?.code ?? 'temporarily_unavailable') as 'invalid_media_id' | 'temporarily_unavailable' | 'invalid_media_size' | 'insufficient_scope',
    known
      ? `${known.message}（errcode=${errcode}）`
      : `微信返回未识别错误（errcode=${errcode}${errmsg ? `，errmsg=${errmsg}` : ''}）`,
  )
  return Object.assign(error, { recoverable: known?.recoverable ?? true })
}

async function defaultTransport(input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}): Promise<WechatDraftTransportResponse> {
  const proxyUrl = await getEffectiveProxyUrl()
  const response = await getFetchFn(proxyUrl)(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal,
  })
  return { status: response.status, text: () => response.text() }
}

interface PlatformPayload {
  media_id?: string
  errcode?: number
  errmsg?: string
  news_item?: Array<Record<string, unknown>>
  item?: Array<{ media_id?: string; content?: { news_item?: Array<Record<string, unknown>> }; update_time?: number }>
}

function toArticle(raw: Record<string, unknown>): WechatDraftArticle {
  return {
    title: String(raw.title ?? ''),
    author: raw.author ? String(raw.author) : undefined,
    digest: raw.digest ? String(raw.digest) : undefined,
    content: String(raw.content ?? ''),
    contentSourceUrl: raw.content_source_url ? String(raw.content_source_url) : undefined,
    thumbMediaId: raw.thumb_media_id ? String(raw.thumb_media_id) : undefined,
    needOpenComment: raw.need_open_comment === 1 || raw.need_open_comment === true,
    onlyFansCanComment: raw.only_fans_can_comment === 1 || raw.only_fans_can_comment === true,
  }
}

function toPlatformArticle(article: WechatDraftArticle): Record<string, unknown> {
  return {
    title: article.title.trim(),
    author: article.author ?? '',
    digest: article.digest ?? '',
    content: article.content,
    content_source_url: article.contentSourceUrl ?? '',
    thumb_media_id: article.thumbMediaId ?? '',
    need_open_comment: article.needOpenComment ? 1 : 0,
    only_fans_can_comment: article.onlyFansCanComment ? 1 : 0,
  }
}

/** 统一的草稿接口调用：处理 token、超时与 errcode。 */
async function callDraftApi(input: {
  credentialRef: string
  endpoint: string
  body: Record<string, unknown>
  dependencies: WechatDraftDependencies
}): Promise<PlatformPayload> {
  const transport = input.dependencies.draftTransport ?? defaultTransport
  return withWechatAccessToken(input.credentialRef, async (accessToken) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await transport({
        url: `${input.endpoint}?access_token=${encodeURIComponent(accessToken)}`,
        method: 'POST',
        // 明确按 UTF-8 发送，否则中文标题会被平台按 latin1 解析成乱码。
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(input.body),
        signal: controller.signal,
      })
      const raw = await response.text()
      let parsed: PlatformPayload
      try {
        parsed = JSON.parse(raw) as PlatformPayload
      } catch {
        throw new PlatformAdapterError('temporarily_unavailable', `微信返回了无法解析的响应（HTTP ${response.status}）`)
      }
      if (parsed.errcode && parsed.errcode !== 0) throw draftError(parsed.errcode, parsed.errmsg)
      return parsed
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PlatformAdapterError('temporarily_unavailable', `草稿接口调用超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
      }
      throw new PlatformAdapterError('temporarily_unavailable', `草稿接口调用失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }, input.dependencies.token ?? {})
}

export interface WechatDraftContext {
  credentialRef: string
  accountId: string
}

export async function createWechatDraft(
  context: WechatDraftContext,
  input: { articles: WechatDraftArticle[]; localDraftId?: string; now?: number },
  dependencies: WechatDraftDependencies = {},
): Promise<WechatDraftRecord> {
  const precheck = precheckWechatDraftArticles(input.articles)
  if (!precheck.ok) throw new PlatformAdapterError('invalid_media_format', `草稿预检未通过：${precheck.problems.join('；')}`)

  const now = input.now ?? dependencies.now?.() ?? Date.now()
  const payload = await callDraftApi({
    credentialRef: context.credentialRef,
    endpoint: DRAFT_ADD_URL,
    body: { articles: input.articles.map(toPlatformArticle) },
    dependencies,
  })
  if (!payload.media_id) throw new PlatformAdapterError('temporarily_unavailable', '微信未返回草稿 media_id，且未给出错误码')

  const record: WechatDraftRecord = {
    id: randomUUID(),
    accountId: context.accountId,
    localDraftId: input.localDraftId,
    platformMediaId: payload.media_id,
    articles: input.articles.map((article) => ({ ...article })),
    localRevision: 1,
    status: 'synced',
    platformSyncTime: now,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  }
  return putNewMediaRecord(WECHAT_DRAFT_KIND, record)
}

export interface UpdateWechatDraftInput {
  articles: WechatDraftArticle[]
  /** 用户在确认冲突后显式选择强制覆盖。 */
  force?: boolean
  now?: number
}

export async function updateWechatDraft(
  context: WechatDraftContext,
  draftId: string,
  input: UpdateWechatDraftInput,
  dependencies: WechatDraftDependencies = {},
): Promise<WechatDraftRecord> {
  const record = await getWechatDraft(draftId)
  if (!record) throw new Error('草稿不存在')
  if (record.accountId !== context.accountId) throw new Error('草稿不属于当前账号')
  if (record.status === 'deleted') throw new Error('草稿已在微信侧删除，不能更新')
  if (!record.platformMediaId) throw new Error('草稿尚未同步到微信，请先创建平台草稿')

  const precheck = precheckWechatDraftArticles(input.articles)
  if (!precheck.ok) throw new PlatformAdapterError('invalid_media_format', `草稿预检未通过：${precheck.problems.join('；')}`)

  const now = input.now ?? dependencies.now?.() ?? Date.now()
  // 更新前比对平台侧更新时间：不一致说明有人在公众号后台改过。
  const remote = await fetchPlatformDraft(context, record.platformMediaId, dependencies)
  const remoteTime = remote?.updateTime
  const conflicted = Boolean(record.platformSyncTime && remoteTime && remoteTime !== record.platformSyncTime)
  if (conflicted && !input.force) {
    const blocked: WechatDraftRecord = { ...record, status: 'update_conflict', lastErrorCode: 'update_conflict', updatedAt: now }
    await putNewMediaRecord(WECHAT_DRAFT_KIND, blocked)
    throw new PlatformAdapterError('insufficient_scope', '平台草稿已被其他人修改，本地更新已阻止；如确认覆盖请显式强制更新')
  }

  await callDraftApi({
    credentialRef: context.credentialRef,
    endpoint: DRAFT_UPDATE_URL,
    // index=0 表示更新多图文的第一篇；当前只支持单篇草稿更新。
    body: { media_id: record.platformMediaId, index: 0, articles: toPlatformArticle(input.articles[0] as WechatDraftArticle) },
    dependencies,
  })

  const updated: WechatDraftRecord = {
    ...record,
    articles: input.articles.map((article) => ({ ...article })),
    localRevision: record.localRevision + 1,
    status: 'synced',
    platformSyncTime: now,
    lastSyncedAt: now,
    lastErrorCode: undefined,
    updatedAt: now,
  }
  return putNewMediaRecord(WECHAT_DRAFT_KIND, updated)
}

export async function fetchPlatformDraft(
  context: WechatDraftContext,
  mediaId: string,
  dependencies: WechatDraftDependencies = {},
): Promise<WechatDraftPlatformData | undefined> {
  const payload = await callDraftApi({
    credentialRef: context.credentialRef,
    endpoint: DRAFT_GET_URL,
    body: { media_id: mediaId },
    dependencies,
  })
  const items = payload.news_item ?? payload.item?.[0]?.content?.news_item ?? []
  if (!items.length) return undefined
  return {
    mediaId,
    articles: items.map(toArticle),
    updateTime: payload.item?.[0]?.update_time,
  }
}

export async function getWechatDraft(draftId: string): Promise<WechatDraftRecord | undefined> {
  return getNewMediaRecord<WechatDraftRecord>(WECHAT_DRAFT_KIND, draftId)
}

export async function listWechatDrafts(accountId?: string): Promise<WechatDraftRecord[]> {
  const drafts = await listNewMediaRecords<WechatDraftRecord>(WECHAT_DRAFT_KIND)
  const scoped = accountId ? drafts.filter((draft) => draft.accountId === accountId) : drafts
  return scoped.sort((left, right) => right.updatedAt - left.updatedAt)
}

export interface DeleteWechatDraftResult {
  record: WechatDraftRecord
  /** true 表示平台已不存在该草稿，本次按幂等恢复处理。 */
  alreadyGone: boolean
}

/**
 * 删除平台草稿。
 *
 * 失败可恢复：保留 media_id 与错误码并标记 delete_failed，用户可稍后重试；
 * 若平台明确返回 media_id 不存在，则视为已删除，避免卡在失败状态。
 */
export async function deleteWechatDraft(
  context: WechatDraftContext,
  draftId: string,
  dependencies: WechatDraftDependencies = {},
): Promise<DeleteWechatDraftResult> {
  const record = await getWechatDraft(draftId)
  if (!record) throw new Error('草稿不存在')
  if (record.accountId !== context.accountId) throw new Error('草稿不属于当前账号')

  const now = dependencies.now?.() ?? Date.now()
  if (record.status === 'deleted') return { record, alreadyGone: true }
  if (!record.platformMediaId) {
    const localOnly: WechatDraftRecord = { ...record, status: 'deleted', lastErrorCode: undefined, updatedAt: now }
    return { record: await putNewMediaRecord(WECHAT_DRAFT_KIND, localOnly), alreadyGone: true }
  }

  try {
    await callDraftApi({
      credentialRef: context.credentialRef,
      endpoint: DRAFT_DELETE_URL,
      body: { media_id: record.platformMediaId },
      dependencies,
    })
  } catch (error) {
    const recoverable = error instanceof PlatformAdapterError && (error as { recoverable?: boolean }).recoverable === true
    const errorCode = error instanceof PlatformAdapterError ? error.code : 'temporarily_unavailable'
    if (recoverable && errorCode === 'invalid_media_id') {
      // 平台已判定不存在：按幂等成功处理，避免卡在 delete_failed。
      const gone: WechatDraftRecord = { ...record, status: 'deleted', lastErrorCode: undefined, updatedAt: now }
      return { record: await putNewMediaRecord(WECHAT_DRAFT_KIND, gone), alreadyGone: true }
    }
    const failed: WechatDraftRecord = { ...record, status: 'delete_failed', lastErrorCode: errorCode, updatedAt: now }
    await putNewMediaRecord(WECHAT_DRAFT_KIND, failed)
    throw error
  }

  const deleted: WechatDraftRecord = { ...record, status: 'deleted', lastErrorCode: undefined, updatedAt: now }
  return { record: await putNewMediaRecord(WECHAT_DRAFT_KIND, deleted), alreadyGone: false }
}

/**
 * 用平台数据覆盖本地草稿（用于解决 update_conflict：以平台为准）。
 */
export async function pullWechatDraftFromPlatform(
  context: WechatDraftContext,
  draftId: string,
  dependencies: WechatDraftDependencies = {},
): Promise<WechatDraftRecord> {
  const record = await getWechatDraft(draftId)
  if (!record) throw new Error('草稿不存在')
  if (record.accountId !== context.accountId) throw new Error('草稿不属于当前账号')
  if (!record.platformMediaId) throw new Error('草稿尚未同步到微信')

  const remote = await fetchPlatformDraft(context, record.platformMediaId, dependencies)
  if (!remote) throw new PlatformAdapterError('invalid_media_id', '平台未返回该草稿内容，可能已被删除')

  const now = dependencies.now?.() ?? Date.now()
  const synced: WechatDraftRecord = {
    ...record,
    articles: remote.articles,
    status: 'synced',
    platformSyncTime: remote.updateTime ?? now,
    lastSyncedAt: now,
    lastErrorCode: undefined,
    updatedAt: now,
  }
  return putNewMediaRecord(WECHAT_DRAFT_KIND, synced)
}
