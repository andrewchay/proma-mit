/**
 * 微信公众号留言只读同步。
 *
 * 边界（与 P4-04 的回复审批流严格区分）：
 * - 只读：仅调用 comment/list 拉取留言，不实现开通留言、精选、删除、回复等任何写操作；
 * - 权限门控：只有账号已连接且真实调用观察过 comment 权限时才启用；
 *   微信返回 48001 会记录为「未授权」并给出明确错误；
 * - 可追溯：每条留言保存 msg_data_id、article_index、user_comment_id 与平台时间戳，
 *   记录 id 由这些字段哈希生成，重复同步不会产生重复数据。
 */
import { createHash } from 'node:crypto'
import type { NewMediaConnectedAccount } from '@gravitas/shared'
import { PlatformAdapterError } from '../platform-adapter'
import { listNewMediaRecords, putNewMediaRecord } from '../new-media-sqlite-store'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { getFetchFn } from '../../proxy-fetch'
import { recordWechatObservedScopes } from '../new-media-account-service'
import { withWechatAccessToken, type WechatTokenDependencies } from './wechat-direct-token-service'

export const WECHAT_COMMENT_KIND = 'wechat-comment'

const COMMENT_LIST_URL = 'https://api.weixin.qq.com/cgi-bin/comment/list'
const REQUEST_TIMEOUT_MS = 20_000

/**
 * 分页限制快照（数值为本地预检声明，需在真机验收时重新核对）。
 * begin 为起始行号；count 为单页条数上限。
 */
export const WECHAT_COMMENT_LIMITS = {
  verifiedAt: '2026-09',
  source: '微信公众平台留言接口文档（本地快照，需在真机验收时重新核对）',
  maxCountPerPage: 50,
  maxPagesPerSync: 10,
} as const

export interface WechatCommentTransportResponse {
  status: number
  text(): Promise<string>
}

export type WechatCommentTransport = (input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}) => Promise<WechatCommentTransportResponse>

export interface WechatCommentDependencies {
  commentTransport?: WechatCommentTransport
  token?: WechatTokenDependencies
  now?: () => number
}

export interface WechatCommentContext {
  credentialRef: string
  accountId: string
}

import type { WechatCommentRecord } from '@gravitas/shared'

export type { WechatCommentRecord }

export const WECHAT_COMMENT_ERROR_CODES: Record<number, { code: string; message: string }> = {
  48001: { code: 'insufficient_scope', message: '该账号没有留言接口权限，无法同步留言' },
  45009: { code: 'temporarily_unavailable', message: '调用频率超限，请稍后重试' },
  '-1': { code: 'temporarily_unavailable', message: '微信侧系统繁忙，稍后重试' },
}

interface CommentListPayload {
  total?: number
  comment_list?: Array<{
    user_comment_id?: number | string
    create_time?: number
    content?: string
    reply_list?: Array<{ content?: string; create_time?: number }>
  }>
  errcode?: number
  errmsg?: string
}

/** 留言同步开关：账号已连接且已观察到 comment 权限。 */
export function isWechatCommentSyncEnabled(account: NewMediaConnectedAccount): boolean {
  if (account.platform !== 'wechat-official-account') return false
  if (account.status !== 'connected') return false
  if (!account.credentialRef) return false
  return account.capabilities.readEngagements || (account.wechatDirect?.grantedScopes.includes('comment') ?? false)
}

function commentRecordId(accountId: string, msgDataId: string, articleIndex: number, userCommentId: string): string {
  const hash = createHash('sha256').update(JSON.stringify({ accountId, msgDataId, articleIndex, userCommentId })).digest('hex')
  return hash.slice(0, 32)
}

async function defaultTransport(input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}): Promise<WechatCommentTransportResponse> {
  const proxyUrl = await getEffectiveProxyUrl()
  const response = await getFetchFn(proxyUrl)(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: input.signal,
  })
  return { status: response.status, text: () => response.text() }
}

async function fetchCommentPage(input: {
  credentialRef: string
  msgDataId: string
  articleIndex: number
  begin: number
  count: number
  dependencies: WechatCommentDependencies
}): Promise<{ total: number; items: Array<Record<string, unknown>> }> {
  return withWechatAccessToken(input.credentialRef, async (accessToken) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const transport = input.dependencies.commentTransport ?? defaultTransport
      const response = await transport({
        url: `${COMMENT_LIST_URL}?access_token=${encodeURIComponent(accessToken)}`,
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ msg_data_id: input.msgDataId, index: input.articleIndex, begin: input.begin, count: input.count }),
        signal: controller.signal,
      })
      const raw = await response.text()
      let parsed: CommentListPayload
      try {
        parsed = JSON.parse(raw) as CommentListPayload
      } catch {
        throw new PlatformAdapterError('temporarily_unavailable', `微信返回了无法解析的响应（HTTP ${response.status}）`)
      }
      if (parsed.errcode && parsed.errcode !== 0) {
        const known = WECHAT_COMMENT_ERROR_CODES[parsed.errcode]
        const message = known
          ? `${known.message}（errcode=${parsed.errcode}）`
          : `微信返回未识别错误（errcode=${parsed.errcode}${parsed.errmsg ? `，errmsg=${parsed.errmsg}` : ''}）`
        throw new PlatformAdapterError((known?.code ?? 'temporarily_unavailable') as 'insufficient_scope' | 'temporarily_unavailable', message)
      }
      return { total: Number(parsed.total ?? 0), items: parsed.comment_list ?? [] }
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PlatformAdapterError('temporarily_unavailable', `留言接口调用超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
      }
      throw new PlatformAdapterError('temporarily_unavailable', `留言接口调用失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }, input.dependencies.token ?? {})
}

export interface SyncWechatCommentsInput {
  msgDataId: string
  articleIndex?: number
  /** 最多同步多少条；受 maxPagesPerSync * maxCountPerPage 约束。 */
  limit?: number
}

export interface SyncWechatCommentsResult {
  msgDataId: string
  articleIndex: number
  fetched: number
  stored: number
  /** 平台返回的留言总数（便于判断是否还有更多页）。 */
  total: number
  pages: number
}

/**
 * 拉取并存储一个图文的留言（只读）。
 *
 * 自动翻页直到取满 limit 或平台返回不足一页；重复同步按
 * msg_data_id + article_index + user_comment_id 去重覆盖，不产生重复记录。
 */
export async function syncWechatComments(
  context: WechatCommentContext,
  input: SyncWechatCommentsInput,
  dependencies: WechatCommentDependencies = {},
): Promise<SyncWechatCommentsResult> {
  const msgDataId = input.msgDataId.trim()
  if (!msgDataId) throw new Error('msg_data_id 不能为空')
  const articleIndex = input.articleIndex ?? 0
  const limit = Math.min(input.limit ?? 100, WECHAT_COMMENT_LIMITS.maxCountPerPage * WECHAT_COMMENT_LIMITS.maxPagesPerSync)
  const syncedAt = dependencies.now?.() ?? Date.now()

  try {
    let begin = 0
    let total = 0
    let fetched = 0
    let stored = 0
    let pages = 0

    while (fetched < limit && pages < WECHAT_COMMENT_LIMITS.maxPagesPerSync) {
      const count = Math.min(WECHAT_COMMENT_LIMITS.maxCountPerPage, limit - fetched)
      const page = await fetchCommentPage({
        credentialRef: context.credentialRef,
        msgDataId,
        articleIndex,
        begin,
        count,
        dependencies,
      })
      pages += 1
      total = page.total || total
      if (page.items.length === 0) break

      for (const item of page.items) {
        fetched += 1
        const userCommentId = String(item.user_comment_id ?? '')
        if (!userCommentId) continue
        const record: WechatCommentRecord = {
          id: commentRecordId(context.accountId, msgDataId, articleIndex, userCommentId),
          accountId: context.accountId,
          msgDataId,
          articleIndex,
          userCommentId,
          content: String(item.content ?? ''),
          createTime: item.create_time === undefined ? undefined : Number(item.create_time),
          replies: ((item.reply_list ?? []) as Array<{ content?: unknown; create_time?: number }>).map((reply) => ({
            content: String(reply.content ?? ''),
            createTime: reply.create_time === undefined ? undefined : Number(reply.create_time),
          })),
          syncedAt,
        }
        await putNewMediaRecord(WECHAT_COMMENT_KIND, record)
        stored += 1
      }

      begin += page.items.length
      if (page.items.length < count) break
    }

    // 留言读取成功，说明账号确实拥有该权限，记录观察结果。
    try {
      await recordWechatObservedScopes(context.accountId, { grantedScopes: ['comment'] })
    } catch {
      // 权限观察是记账行为，失败不影响留言同步结果。
    }

    return { msgDataId, articleIndex, fetched, stored, total, pages }
  } catch (error) {
    // 平台明确拒绝（48001）说明留言权限不可用，撤销本地观察，避免继续越权尝试。
    if (error instanceof PlatformAdapterError && error.code === 'insufficient_scope') {
      try {
        await recordWechatObservedScopes(context.accountId, { deniedScopes: ['comment'] })
      } catch {
        // 记账失败不影响错误抛出。
      }
    }
    throw error
  }
}

export async function listWechatComments(accountId: string, msgDataId?: string): Promise<WechatCommentRecord[]> {
  const rows = await listNewMediaRecords<WechatCommentRecord>(WECHAT_COMMENT_KIND)
  const scoped = rows.filter((row) => row.accountId === accountId && (msgDataId === undefined || row.msgDataId === msgDataId))
  return scoped.sort((left, right) => (right.createTime ?? 0) - (left.createTime ?? 0))
}

/** 批量导入留言仅用于测试：与真实拉取共用同一存储与去重逻辑。 */
export async function importWechatCommentsForTests(input: {
  accountId: string
  msgDataId: string
  articleIndex?: number
  comments: Array<{ userCommentId: string; content: string; createTime?: number }>
}): Promise<number> {
  const articleIndex = input.articleIndex ?? 0
  let stored = 0
  const syncedAt = Date.now()
  for (const item of input.comments) {
    const record: WechatCommentRecord = {
      id: commentRecordId(input.accountId, input.msgDataId, articleIndex, item.userCommentId),
      accountId: input.accountId,
      msgDataId: input.msgDataId,
      articleIndex,
      userCommentId: item.userCommentId,
      content: item.content,
      createTime: item.createTime,
      replies: [],
      syncedAt,
    }
    await putNewMediaRecord(WECHAT_COMMENT_KIND, record)
    stored += 1
  }
  return stored
}
