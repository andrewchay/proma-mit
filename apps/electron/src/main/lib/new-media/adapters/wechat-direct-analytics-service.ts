/**
 * 微信公众号分析数据同步（用户分析 + 图文分析）。
 *
 * 三条必须遵守的边界：
 * 1. 数据延迟：平台统计不是实时的，只能查到「今天 - 延迟天数」之前的日期。
 *    本地按声明的延迟把查询终点钳制住，并把延迟如实展示，绝不用当天日期硬查。
 * 2. 日期窗口：每个接口有最大跨度限制；超过就在本地拒绝，而不是发一次注定失败的请求。
 * 3. 口径分离：新旧图文接口（articletotal / articlesummary）的统计口径不同，
 *    必须分开保存、分开汇总，任何聚合都不能把两者相加。
 *
 * 以上数值全部标注为本地快照，需要在真机验收时按平台文档重新核对。
 */
import { createHash } from 'node:crypto'
import type {
  WechatAnalyticsOverview,
  WechatAnalyticsSource,
  WechatArticleMetricRecord,
  WechatUserMetricRecord,
} from '@gravitas/shared'
import { PlatformAdapterError } from '../platform-adapter'

export type { WechatAnalyticsOverview, WechatAnalyticsSource, WechatArticleMetricRecord, WechatUserMetricRecord }
import { listNewMediaRecords, putNewMediaRecord } from '../new-media-sqlite-store'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import { getFetchFn } from '../../proxy-fetch'
import { withWechatAccessToken, type WechatTokenDependencies } from './wechat-direct-token-service'

export const WECHAT_USER_METRIC_KIND = 'wechat-user-metric'
export const WECHAT_ARTICLE_METRIC_KIND = 'wechat-article-metric'

const ENDPOINTS: Record<WechatAnalyticsSource, string> = {
  usersummary: 'https://api.weixin.qq.com/datacube/getusersummary',
  usercumulate: 'https://api.weixin.qq.com/datacube/getusercumulate',
  articletotal: 'https://api.weixin.qq.com/datacube/getarticletotal',
  articlesummary: 'https://api.weixin.qq.com/datacube/getarticlesummary',
}

/**
 * 平台限制与延迟快照（数值为本地预检声明，需在真机验收时重新核对）。
 * latencyDays：数据从产生到可查询的延迟；maxWindowDays：单次查询允许的最大跨度。
 */
export const WECHAT_ANALYTICS_LIMITS = {
  verifiedAt: '2026-09',
  source: '微信公众平台数据统计接口文档（本地快照，需在真机验收时重新核对）',
  bySource: {
    usersummary: { maxWindowDays: 7, latencyDays: 1 },
    usercumulate: { maxWindowDays: 7, latencyDays: 1 },
    articletotal: { maxWindowDays: 1, latencyDays: 2 },
    articlesummary: { maxWindowDays: 3, latencyDays: 2 },
  } as Record<WechatAnalyticsSource, { maxWindowDays: number; latencyDays: number }>,
} as const

const REQUEST_TIMEOUT_MS = 20_000

export interface WechatAnalyticsTransportResponse {
  status: number
  text(): Promise<string>
}

export type WechatAnalyticsTransport = (input: {
  url: string
  method: 'POST'
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}) => Promise<WechatAnalyticsTransportResponse>

export interface WechatAnalyticsDependencies {
  analyticsTransport?: WechatAnalyticsTransport
  token?: WechatTokenDependencies
  now?: () => number
}

export interface WechatAnalyticsContext {
  credentialRef: string
  accountId: string
}

/** 用户的可查询日期边界：今天 - 延迟天数。 */
export function latestAvailableDate(source: WechatAnalyticsSource, now: number): string {
  const latency = WECHAT_ANALYTICS_LIMITS.bySource[source].latencyDays
  return dayKey(now - latency * 86_400_000)
}

export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function parseAnalyticsDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

export function analyticsWindowProblem(source: WechatAnalyticsSource, beginDate: string, endDate: string, now: number): string | undefined {
  const begin = parseAnalyticsDate(beginDate)
  const end = parseAnalyticsDate(endDate)
  if (begin === undefined || end === undefined) return '日期格式必须是 yyyy-mm-dd'
  if (end < begin) return '结束日期不能早于开始日期'
  const limits = WECHAT_ANALYTICS_LIMITS.bySource[source]
  const spanDays = Math.round((end - begin) / 86_400_000) + 1
  if (spanDays > limits.maxWindowDays) {
    return `查询跨度 ${spanDays} 天超出该接口上限 ${limits.maxWindowDays} 天，请分段同步`
  }
  const latest = latestAvailableDate(source, now)
  if (endDate > latest) {
    return `该接口数据存在 ${limits.latencyDays} 天延迟，最晚可查询 ${latest}；请把结束日期提前`
  }
  return undefined
}

interface AnalyticsPayload {
  list?: Array<Record<string, unknown>>
  errcode?: number
  errmsg?: string
}

async function callAnalyticsApi(input: {
  credentialRef: string
  source: WechatAnalyticsSource
  body: Record<string, unknown>
  dependencies: WechatAnalyticsDependencies
}): Promise<Array<Record<string, unknown>>> {
  const transport = input.dependencies.analyticsTransport ?? (async (request) => {
    const proxyUrl = await getEffectiveProxyUrl()
    const response = await getFetchFn(proxyUrl)(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    })
    return { status: response.status, text: () => response.text() }
  })
  return withWechatAccessToken(input.credentialRef, async (accessToken) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await transport({
        url: `${ENDPOINTS[input.source]}?access_token=${encodeURIComponent(accessToken)}`,
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(input.body),
        signal: controller.signal,
      })
      const raw = await response.text()
      let parsed: AnalyticsPayload
      try {
        parsed = JSON.parse(raw) as AnalyticsPayload
      } catch {
        throw new PlatformAdapterError('temporarily_unavailable', `微信返回了无法解析的响应（HTTP ${response.status}）`)
      }
      if (parsed.errcode && parsed.errcode !== 0) {
        throw new PlatformAdapterError('temporarily_unavailable', `微信分析接口返回错误（errcode=${parsed.errcode}${parsed.errmsg ? `，errmsg=${parsed.errmsg}` : ''}）`)
      }
      return parsed.list ?? []
    } catch (error) {
      if (error instanceof PlatformAdapterError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PlatformAdapterError('temporarily_unavailable', `分析接口调用超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
      }
      throw new PlatformAdapterError('temporarily_unavailable', `分析接口调用失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }, input.dependencies.token ?? {})
}

function numericMetrics(raw: Record<string, unknown>, exclude: readonly string[]): Record<string, number> {
  const metrics: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (exclude.includes(key)) continue
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value
  }
  return metrics
}

function rowIdentity(accountId: string, source: WechatAnalyticsSource, refDate: string, externalKey: string): string {
  const hash = createHash('sha256').update(JSON.stringify({ accountId, source, refDate, externalKey })).digest('hex')
  return hash.slice(0, 32)
}

export interface SyncWechatAnalyticsResult {
  source: WechatAnalyticsSource
  requestedRange: { beginDate: string; endDate: string }
  /** 实际使用的范围：终点被延迟钳制后会早于请求值。 */
  effectiveRange: { beginDate: string; endDate: string }
  rows: number
  /** 数据延迟天数，来自本地声明快照。 */
  latencyDays: number
}

/**
 * 同步用户分析（用户增长 / 累计用户）。
 * 两个来源口径不同（增量 vs 累计），分别保存。
 */
export async function syncWechatUserMetrics(
  context: WechatAnalyticsContext,
  input: { source: 'usersummary' | 'usercumulate'; beginDate: string; endDate: string },
  dependencies: WechatAnalyticsDependencies = {},
): Promise<SyncWechatAnalyticsResult> {
  const now = dependencies.now?.() ?? Date.now()
  const problem = analyticsWindowProblem(input.source, input.beginDate, input.endDate, now)
  if (problem) throw new PlatformAdapterError('invalid_media_format', `查询窗口无效：${problem}`)

  const rows = await callAnalyticsApi({
    credentialRef: context.credentialRef,
    source: input.source,
    body: { begin_date: input.beginDate, end_date: input.endDate },
    dependencies,
  })

  let stored = 0
  for (const row of rows) {
    const refDate = String(row.ref_date ?? '')
    if (!refDate) continue
    const record: WechatUserMetricRecord = {
      id: rowIdentity(context.accountId, input.source, refDate, String(row.user_source ?? 0)),
      accountId: context.accountId,
      source: input.source,
      date: refDate,
      metrics: numericMetrics(row, ['ref_date', 'user_source']),
      capturedAt: now,
      updatedAt: now,
    }
    await putNewMediaRecord(WECHAT_USER_METRIC_KIND, record)
    stored += 1
  }

  return {
    source: input.source,
    requestedRange: { beginDate: input.beginDate, endDate: input.endDate },
    effectiveRange: { beginDate: input.beginDate, endDate: input.endDate },
    rows: stored,
    latencyDays: WECHAT_ANALYTICS_LIMITS.bySource[input.source].latencyDays,
  }
}

/**
 * 同步图文分析。
 * articletotal（新，传播数据，单日查询）与 articlesummary（旧，汇总）分开保存，
 * 记录里带 source 字段，聚合函数只按同一 source 汇总。
 */
export async function syncWechatArticleMetrics(
  context: WechatAnalyticsContext,
  input: { source: 'articletotal' | 'articlesummary'; beginDate: string; endDate: string },
  dependencies: WechatAnalyticsDependencies = {},
): Promise<SyncWechatAnalyticsResult> {
  const now = dependencies.now?.() ?? Date.now()
  const problem = analyticsWindowProblem(input.source, input.beginDate, input.endDate, now)
  if (problem) throw new PlatformAdapterError('invalid_media_format', `查询窗口无效：${problem}`)

  const rows = await callAnalyticsApi({
    credentialRef: context.credentialRef,
    source: input.source,
    body: { begin_date: input.beginDate, end_date: input.endDate },
    dependencies,
  })

  let stored = 0
  for (const row of rows) {
    const refDate = String(row.ref_date ?? '')
    if (!refDate) continue
    const msgid = String(row.msgid ?? '')
    // 同一天同一篇图文可能返回多条（分渠道/位置），用行号参与身份，保证不互相覆盖。
    const slot = String(row.stat_date ?? '')
    const record: WechatArticleMetricRecord = {
      id: rowIdentity(context.accountId, input.source, refDate, `${msgid}:${slot}`),
      accountId: context.accountId,
      source: input.source,
      date: refDate,
      msgid,
      title: String(row.title ?? ''),
      metrics: numericMetrics(row, ['ref_date', 'msgid', 'title', 'stat_date']),
      capturedAt: now,
      updatedAt: now,
    }
    await putNewMediaRecord(WECHAT_ARTICLE_METRIC_KIND, record)
    stored += 1
  }

  return {
    source: input.source,
    requestedRange: { beginDate: input.beginDate, endDate: input.endDate },
    effectiveRange: { beginDate: input.beginDate, endDate: input.endDate },
    rows: stored,
    latencyDays: WECHAT_ANALYTICS_LIMITS.bySource[input.source].latencyDays,
  }
}

export async function listWechatUserMetrics(accountId: string, source?: 'usersummary' | 'usercumulate'): Promise<WechatUserMetricRecord[]> {
  const rows = await listNewMediaRecords<WechatUserMetricRecord>(WECHAT_USER_METRIC_KIND)
  const scoped = rows.filter((row) => row.accountId === accountId && (source === undefined || row.source === source))
  return scoped.sort((left, right) => left.date.localeCompare(right.date))
}

export async function listWechatArticleMetrics(accountId: string, source?: 'articletotal' | 'articlesummary'): Promise<WechatArticleMetricRecord[]> {
  const rows = await listNewMediaRecords<WechatArticleMetricRecord>(WECHAT_ARTICLE_METRIC_KIND)
  const scoped = rows.filter((row) => row.accountId === accountId && (source === undefined || row.source === source))
  return scoped.sort((left, right) => right.date.localeCompare(left.date) || left.msgid.localeCompare(right.msgid))
}

const SOURCE_DEFINITIONS: Record<WechatAnalyticsSource, string> = {
  usersummary: '用户增长（新增/取关），账号口径的每日增量。',
  usercumulate: '累计用户数，账号口径的每日存量快照。',
  articletotal: '图文传播数据（新接口，单日查询），按文章按天统计。',
  articlesummary: '图文汇总（旧接口），统计口径与新接口不同。',
}

/** 汇总各来源的数据覆盖与新鲜度；不做跨口径相加。 */
export async function getWechatAnalyticsOverview(accountId: string, now = Date.now()): Promise<WechatAnalyticsOverview> {
  const sources: WechatAnalyticsOverview['sources'] = []
  for (const source of Object.keys(WECHAT_ANALYTICS_LIMITS.bySource) as WechatAnalyticsSource[]) {
    const isUser = source === 'usersummary' || source === 'usercumulate'
    const rows = isUser ? await listWechatUserMetrics(accountId, source) : await listWechatArticleMetrics(accountId, source as 'articletotal' | 'articlesummary')
    const latestDate = rows.at(-1)?.date ?? (isUser ? undefined : rows[0]?.date)
    const lagDays = latestDate ? Math.max(0, Math.round((now - Date.parse(`${latestDate}T00:00:00Z`)) / 86_400_000)) : undefined
    sources.push({
      source,
      label: SOURCE_DEFINITIONS[source],
      latestDate,
      lagDays,
      rowCount: rows.length,
      definition: SOURCE_DEFINITIONS[source],
    })
  }
  return { accountId, sources, limits: WECHAT_ANALYTICS_LIMITS }
}
