import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PlatformAdapterError } from '../platform-adapter'
import { saveWechatDirectCredential } from './wechat-direct-credential'
import { clearWechatTokenCache, type WechatTokenTransport } from './wechat-direct-token-service'
import {
  WECHAT_ANALYTICS_LIMITS,
  analyticsWindowProblem,
  getWechatAnalyticsOverview,
  latestAvailableDate,
  listWechatArticleMetrics,
  listWechatUserMetrics,
  syncWechatArticleMetrics,
  syncWechatUserMetrics,
  type WechatAnalyticsTransport,
} from './wechat-direct-analytics-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REF = 'ref-analytics'
const CONTEXT = { credentialRef: REF, accountId: 'acc-1' }

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-analytics-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearWechatTokenCache(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearWechatTokenCache(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const tokenTransport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-ANALYTICS', expires_in: 7200 }) })
/** now 统一以函数注入，与服务层依赖签名一致。 */
const deps = (transport: WechatAnalyticsTransport, now = Date.parse('2026-09-15T10:00:00Z')) => ({ analyticsTransport: transport, token: { transport: tokenTransport }, now: () => now })

function analyticsTransport(routes: Partial<Record<string, unknown>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const transport: WechatAnalyticsTransport = async (input) => {
    const body = JSON.parse(input.body) as { begin_date: string; end_date: string }
    calls.push({ url: input.url, body })
    const endpoint = input.url.split('?')[0] ?? ''
    const payload = endpoint.endsWith('/getusersummary') ? routes.getusersummary
      : endpoint.endsWith('/getusercumulate') ? routes.getusercumulate
        : endpoint.endsWith('/getarticletotal') ? routes.getarticletotal
          : routes.getarticlesummary
    // 平台错误直接返回，不走行过滤。
    if (payload && typeof payload === 'object' && 'errcode' in (payload as Record<string, unknown>)) {
      return { status: 200, text: async () => JSON.stringify(payload) }
    }
    // 与真实接口一致：只返回请求窗口内的行。
    const list = (payload as { list?: Array<Record<string, unknown>> } | undefined)?.list
      ?.filter((row) => String(row.ref_date) >= body.begin_date && String(row.ref_date) <= body.end_date) ?? []
    return { status: 200, text: async () => JSON.stringify({ list }) }
  }
  return { transport, calls }
}

function configure(): void {
  saveWechatDirectCredential(REF, { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
}

describe('P2-07 日期窗口与数据延迟', () => {
  test('最晚可查日期按声明的延迟钳制', () => {
    const now = Date.parse('2026-09-15T10:00:00Z')
    expect(latestAvailableDate('usersummary', now)).toBe('2026-09-14')
    expect(latestAvailableDate('articletotal', now)).toBe('2026-09-13')
  })

  test('窗口跨度、日期格式与延迟上限都在本地拒绝', () => {
    const now = Date.parse('2026-09-15T10:00:00Z')
    // 09-08 到 09-14 恰好 7 天，且不落入延迟区间
    expect(analyticsWindowProblem('usersummary', '2026-09-08', '2026-09-14', now)).toBeUndefined()
    // 14 天跨度超限
    expect(analyticsWindowProblem('usersummary', '2026-09-01', '2026-09-14', now)).toContain('查询跨度 14 天')
    // articletotal 只允许单日
    expect(analyticsWindowProblem('articletotal', '2026-09-12', '2026-09-13', now)).toContain('超出该接口上限')
    expect(analyticsWindowProblem('articletotal', '2026-09-13', '2026-09-13', now)).toBeUndefined()
    // 结束日期落在延迟区间内
    expect(analyticsWindowProblem('usersummary', '2026-09-14', '2026-09-15', now)).toContain('存在 1 天延迟')
    expect(analyticsWindowProblem('articletotal', '2026-09-14', '2026-09-14', now)).toContain('存在 2 天延迟')
    expect(analyticsWindowProblem('usersummary', '2026/09/01', '2026-09-05', now)).toContain('yyyy-mm-dd')
    expect(analyticsWindowProblem('usersummary', '2026-09-05', '2026-09-01', now)).toContain('不能早于')
  })

  test('限制数值标注为本地快照', () => {
    expect(WECHAT_ANALYTICS_LIMITS.source).toContain('需在真机验收时重新核对')
    expect(WECHAT_ANALYTICS_LIMITS.verifiedAt).toBeTruthy()
  })
})

describe('P2-07 用户分析同步', () => {
  test('增长与累计分别保存，聚合不混口径', async () => {
    configure()
    const now = Date.parse('2026-09-15T10:00:00Z')
    const { transport } = analyticsTransport({
      getusersummary: { list: [
        { ref_date: '2026-09-13', user_source: 0, new_user: 120, cancel_user: 15 },
        { ref_date: '2026-09-14', user_source: 0, new_user: 150, cancel_user: 10 },
      ] },
      getusercumulate: { list: [{ ref_date: '2026-09-14', cumulate_user: 52000 }] },
    })

    const summary = await syncWechatUserMetrics(CONTEXT, { source: 'usersummary', beginDate: '2026-09-13', endDate: '2026-09-14' }, deps(transport, now))
    expect(summary.rows).toBe(2)
    expect(summary.latencyDays).toBe(1)
    const cumulate = await syncWechatUserMetrics(CONTEXT, { source: 'usercumulate', beginDate: '2026-09-14', endDate: '2026-09-14' }, deps(transport, now))
    expect(cumulate.rows).toBe(1)

    const summaryRows = await listWechatUserMetrics('acc-1', 'usersummary')
    expect(summaryRows.map((row) => row.date)).toEqual(['2026-09-13', '2026-09-14'])
    expect(summaryRows[0]?.metrics.new_user).toBe(120)
    expect(summaryRows[0]?.metrics.cancel_user).toBe(15)
    expect(summaryRows[0]?.metrics.cumulate_user).toBeUndefined()

    const cumulateRows = await listWechatUserMetrics('acc-1', 'usercumulate')
    expect(cumulateRows[0]?.metrics.cumulate_user).toBe(52000)
    expect(cumulateRows[0]?.metrics.new_user).toBeUndefined()

    const overview = await getWechatAnalyticsOverview('acc-1', now)
    const summaryEntry = overview.sources.find((entry) => entry.source === 'usersummary')
    expect(summaryEntry?.latestDate).toBe('2026-09-14')
    expect(summaryEntry?.lagDays).toBe(1)
    expect(summaryEntry?.definition).toContain('增量')
    expect(overview.limits.source).toContain('本地快照')
  })

  test('同一日期重复同步按确定性 id 覆盖，不重复计数', async () => {
    configure()
    const now = Date.parse('2026-09-15T10:00:00Z')
    const { transport } = analyticsTransport({ getusersummary: { list: [{ ref_date: '2026-09-14', user_source: 0, new_user: 150, cancel_user: 10 }] } })
    await syncWechatUserMetrics(CONTEXT, { source: 'usersummary', beginDate: '2026-09-14', endDate: '2026-09-14' }, deps(transport, now))
    const updated = analyticsTransport({ getusersummary: { list: [{ ref_date: '2026-09-14', user_source: 0, new_user: 160, cancel_user: 12 }] } })
    await syncWechatUserMetrics(CONTEXT, { source: 'usersummary', beginDate: '2026-09-14', endDate: '2026-09-14' }, deps(updated.transport, now))

    const rows = await listWechatUserMetrics('acc-1', 'usersummary')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metrics.new_user).toBe(160)
  })

  test('窗口无效时不出网并给出明确原因', async () => {
    configure()
    const now = Date.parse('2026-09-15T10:00:00Z')
    const { transport, calls } = analyticsTransport({})
    await expect(syncWechatUserMetrics(CONTEXT, { source: 'usersummary', beginDate: '2026-09-01', endDate: '2026-09-15' }, deps(transport, now))).rejects.toThrow(/超出该接口上限/)
    await expect(syncWechatArticleMetrics(CONTEXT, { source: 'articletotal', beginDate: '2026-09-12', endDate: '2026-09-14' }, deps(transport, now))).rejects.toThrow(/查询窗口无效/)
    expect(calls).toHaveLength(0)
  })
})

describe('P2-07 图文分析同步与口径分离', () => {
  test('新接口与旧接口分开保存，聚合各算各的', async () => {
    configure()
    const now = Date.parse('2026-09-15T10:00:00Z')
    const { transport } = analyticsTransport({
      getarticletotal: { list: [
        { ref_date: '2026-09-13', msgid: '10001', title: '新接口文章', int_page_read_count: 5000, share_count: 60 },
      ] },
      getarticlesummary: { list: [
        { ref_date: '2026-09-13', msgid: '10001', title: '旧接口文章', int_page_read_count: 4800, share_count: 55 },
      ] },
    })

    await syncWechatArticleMetrics(CONTEXT, { source: 'articletotal', beginDate: '2026-09-13', endDate: '2026-09-13' }, deps(transport, now))
    await syncWechatArticleMetrics(CONTEXT, { source: 'articlesummary', beginDate: '2026-09-13', endDate: '2026-09-13' }, deps(transport, now))

    const newRows = await listWechatArticleMetrics('acc-1', 'articletotal')
    const oldRows = await listWechatArticleMetrics('acc-1', 'articlesummary')
    expect(newRows).toHaveLength(1)
    expect(oldRows).toHaveLength(1)
    expect(newRows[0]?.id).not.toBe(oldRows[0]?.id)
    expect(newRows[0]?.metrics.int_page_read_count).toBe(5000)
    expect(oldRows[0]?.metrics.int_page_read_count).toBe(4800)
    // 同一 msgid 在两个口径下是两条独立记录，绝不能合并
    expect(new Set([newRows[0]?.id, oldRows[0]?.id]).size).toBe(2)
  })

  test('同一天同文章的多条渠道行分别保留', async () => {
    configure()
    const now = Date.parse('2026-09-15T10:00:00Z')
    const { transport } = analyticsTransport({
      getarticletotal: { list: [
        { ref_date: '2026-09-12', msgid: '20001', stat_date: '2026-09-12', int_page_read_count: 300 },
        { ref_date: '2026-09-13', msgid: '20001', stat_date: '2026-09-13', int_page_read_count: 500 },
      ] },
    })
    await syncWechatArticleMetrics(CONTEXT, { source: 'articletotal', beginDate: '2026-09-12', endDate: '2026-09-12' }, deps(transport, now))
    const rows = await listWechatArticleMetrics('acc-1', 'articletotal')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metrics.int_page_read_count).toBe(300)

    await syncWechatArticleMetrics(CONTEXT, { source: 'articletotal', beginDate: '2026-09-13', endDate: '2026-09-13' }, deps(transport, now))
    const afterSecond = await listWechatArticleMetrics('acc-1', 'articletotal')
    expect(afterSecond).toHaveLength(2)
    expect(afterSecond.map((row) => row.date).sort()).toEqual(['2026-09-12', '2026-09-13'])
  })

  test('平台错误被包装为可诊断错误，不暴露凭据', async () => {
    configure()
    const { transport } = analyticsTransport({ getusersummary: { errcode: 48001, errmsg: 'api unauthorized' } })
    const error: Error = await syncWechatUserMetrics(CONTEXT, { source: 'usersummary', beginDate: '2026-09-13', endDate: '2026-09-14' }, deps(transport)).then(
      () => { throw new Error('预期同步失败') },
      (caught: Error) => caught,
    )
    expect(error.message).toContain('errcode=48001')
    expect(error.message).not.toContain(APP_SECRET)
  })

  test('跨账号数据互不可见', async () => {
    configure()
    const now = Date.parse('2026-09-15T10:00:00Z')
    const { transport } = analyticsTransport({ getusersummary: { list: [{ ref_date: '2026-09-14', user_source: 0, new_user: 9 }] } })
    await syncWechatUserMetrics(CONTEXT, { source: 'usersummary', beginDate: '2026-09-14', endDate: '2026-09-14' }, deps(transport, now))
    expect(await listWechatUserMetrics('acc-2')).toEqual([])
    expect(await listWechatUserMetrics('acc-1')).toHaveLength(1)
  })

  test('空结果返回零行而不是报错（平台对延迟日期可能返回空列表）', async () => {
    configure()
    const { transport } = analyticsTransport({ getarticletotal: { list: [] } })
    const result = await syncWechatArticleMetrics(CONTEXT, { source: 'articletotal', beginDate: '2026-09-13', endDate: '2026-09-13' }, deps(transport, Date.parse('2026-09-15T10:00:00Z')))
    expect(result.rows).toBe(0)
  })
})
