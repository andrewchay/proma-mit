import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NewMediaConnectedAccount } from '@gravitas/shared'
import { saveWechatDirectCredential } from './wechat-direct-credential'
import { clearWechatTokenCache, type WechatTokenTransport } from './wechat-direct-token-service'
import {
  WECHAT_COMMENT_LIMITS,
  importWechatCommentsForTests,
  isWechatCommentSyncEnabled,
  listWechatComments,
  syncWechatComments,
  type WechatCommentTransport,
} from './wechat-direct-comment-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REF = 'ref-comment'
const CONTEXT = { credentialRef: REF, accountId: 'acc-1' }

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-comment-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearWechatTokenCache(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearWechatTokenCache(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const tokenTransport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-COMMENT', expires_in: 7200 }) })
const deps = (transport: WechatCommentTransport) => ({ commentTransport: transport, token: { transport: tokenTransport } })

function commentTransport(pages: Array<{ total?: number; comment_list?: Array<Record<string, unknown>> } | { errcode: number; errmsg?: string }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  // 每次调用取下一个预置页，并按请求的 count 截断——与真实接口的分页行为一致。
  let pageIndex = 0
  const transport: WechatCommentTransport = async (input) => {
    const body = JSON.parse(input.body) as { begin: number; count: number }
    calls.push({ url: input.url, body })
    const page = (pages[pageIndex] ?? pages.at(-1) ?? {}) as { total?: number; comment_list?: Array<Record<string, unknown>> }
    pageIndex += 1
    if (page && 'errcode' in page) return { status: 200, text: async () => JSON.stringify(page) }
    const list = (page.comment_list ?? []).slice(0, body.count)
    return { status: 200, text: async () => JSON.stringify({ total: page.total, comment_list: list }) }
  }
  return { transport, calls }
}

function makeComment(id: number, content: string): Record<string, unknown> {
  return { user_comment_id: id, create_time: 1_700_000_000 + id, content, reply_list: id % 2 === 0 ? [{ content: '官方回复', create_time: 1_700_000_500 }] : [] }
}

function account(overrides: Partial<NewMediaConnectedAccount> = {}): NewMediaConnectedAccount {
  return {
    id: 'acc-1',
    platform: 'wechat-official-account',
    displayName: '服务号',
    status: 'connected',
    authorizationMethod: 'wechat_direct',
    grantedScopes: [],
    capabilities: { localDraft: true, remoteDraft: false, publish: false, readEngagements: true, sendReply: false, readMetrics: false },
    credentialRef: REF,
    credentialProtection: 'encrypted',
    createdAt: 0,
    updatedAt: 0,
    wechatDirect: { appId: APP_ID, accountType: 'service', verificationStatus: 'verified', grantedScopes: ['comment'], ipWhitelistConfigured: true },
    ...overrides,
  }
}

function configure(): void {
  saveWechatDirectCredential(REF, { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
}

describe('P2-08 留言权限门控', () => {
  test('仅已连接且观察到 comment 权限的账号启用同步', () => {
    expect(isWechatCommentSyncEnabled(account())).toBe(true)
    expect(isWechatCommentSyncEnabled(account({ status: 'disconnected' }))).toBe(false)
    expect(isWechatCommentSyncEnabled(account({ credentialRef: undefined }))).toBe(false)
    expect(isWechatCommentSyncEnabled(account({
      capabilities: { localDraft: true, remoteDraft: false, publish: false, readEngagements: false, sendReply: false, readMetrics: false },
      wechatDirect: { appId: APP_ID, accountType: 'service', verificationStatus: 'verified', grantedScopes: [], ipWhitelistConfigured: true },
    }))).toBe(false)
    expect(isWechatCommentSyncEnabled(account({
      platform: 'xiaohongshu',
      wechatDirect: undefined,
    }))).toBe(false)
  })

  test('缺少留言权限（48001）时给出明确错误', async () => {
    configure()
    const { transport } = commentTransport([{ errcode: 48001, errmsg: 'api unauthorized' }])
    const error: Error = await syncWechatComments(CONTEXT, { msgDataId: 'MSG-1' }, deps(transport)).then(
      () => { throw new Error('预期同步失败') },
      (caught: Error) => caught,
    )
    expect(error.message).toContain('没有留言接口权限')
    expect(error.message).toContain('48001')
  })
})

describe('P2-08 留言拉取、分页与去重', () => {
  test('单页拉取并保存内容、平台时间与回复', async () => {
    configure()
    const { transport, calls } = commentTransport([{ total: 2, comment_list: [makeComment(1, '写得好'), makeComment(2, '求链接')] }])
    const result = await syncWechatComments(CONTEXT, { msgDataId: 'MSG-100', articleIndex: 0 }, deps(transport))

    expect(result.fetched).toBe(2)
    expect(result.stored).toBe(2)
    expect(result.total).toBe(2)
    expect(calls[0]?.body).toMatchObject({ msg_data_id: 'MSG-100', index: 0, begin: 0, count: WECHAT_COMMENT_LIMITS.maxCountPerPage })

    const rows = await listWechatComments('acc-1', 'MSG-100')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.content).toBe('求链接')
    expect(rows[0]?.msgDataId).toBe('MSG-100')
    expect(rows[0]?.articleIndex).toBe(0)
    expect(rows[0]?.userCommentId).toBe('2')
    expect(rows[0]?.replies[0]?.content).toBe('官方回复')
    expect(rows[0]?.createTime).toBeDefined()
  })

  test('超过单页上限时自动翻页，页数受快照上限约束', async () => {
    configure()
    const firstPage = Array.from({ length: WECHAT_COMMENT_LIMITS.maxCountPerPage }, (_, index) => makeComment(index + 1, `第${index + 1}条`))
    const secondPage = Array.from({ length: 20 }, (_, index) => makeComment(1000 + index, `第二页第${index + 1}条`))
    const { transport, calls } = commentTransport([
      { total: WECHAT_COMMENT_LIMITS.maxCountPerPage + 20, comment_list: firstPage },
      { comment_list: secondPage },
    ])
    const result = await syncWechatComments(CONTEXT, { msgDataId: 'MSG-200' }, deps(transport))

    expect(result.pages).toBe(2)
    expect(result.stored).toBe(WECHAT_COMMENT_LIMITS.maxCountPerPage + 20)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.body.begin).toBe(WECHAT_COMMENT_LIMITS.maxCountPerPage)
    expect(await listWechatComments('acc-1', 'MSG-200')).toHaveLength(WECHAT_COMMENT_LIMITS.maxCountPerPage + 20)
  })

  test('limit 限制拉取规模，翻页提前停止', async () => {
    configure()
    const firstPage = Array.from({ length: WECHAT_COMMENT_LIMITS.maxCountPerPage }, (_, index) => makeComment(index + 1, `第${index + 1}条`))
    const { transport, calls } = commentTransport([{ total: 500, comment_list: firstPage }, { comment_list: firstPage }])
    const result = await syncWechatComments(CONTEXT, { msgDataId: 'MSG-300', limit: 10 }, deps(transport))

    // limit=10 时单页就取满，停止翻页
    expect(result.fetched).toBe(10)
    expect(result.pages).toBe(1)
    expect(calls).toHaveLength(1)
    expect(await listWechatComments('acc-1', 'MSG-300')).toHaveLength(10)
  })

  test('重复同步按 msg_data_id + user_comment_id 去重覆盖', async () => {
    configure()
    const { transport, calls } = commentTransport([{ total: 2, comment_list: [makeComment(1, '写得好'), makeComment(2, '求链接')] }])
    await syncWechatComments(CONTEXT, { msgDataId: 'MSG-400' }, deps(transport))
    const updated = commentTransport([{ total: 2, comment_list: [makeComment(1, '写得好（已精选）'), makeComment(2, '求链接')] }])
    await syncWechatComments(CONTEXT, { msgDataId: 'MSG-400' }, deps(updated.transport))

    const rows = await listWechatComments('acc-1', 'MSG-400')
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.userCommentId === '1')?.content).toBe('写得好（已精选）')
    expect(calls).toHaveLength(1)
  })

  test('同一 msg_data_id 不同图文序号的留言互不覆盖', async () => {
    configure()
    await importWechatCommentsForTests({ accountId: 'acc-1', msgDataId: 'MSG-500', articleIndex: 0, comments: [{ userCommentId: '7', content: '第一篇留言' }] })
    await importWechatCommentsForTests({ accountId: 'acc-1', msgDataId: 'MSG-500', articleIndex: 1, comments: [{ userCommentId: '7', content: '第二篇留言' }] })
    const rows = await listWechatComments('acc-1', 'MSG-500')
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.articleIndex)).size).toBe(2)
  })

  test('跨账号与跨图文数据互不可见，且不保存本地路径', async () => {
    configure()
    await importWechatCommentsForTests({ accountId: 'acc-1', msgDataId: 'MSG-600', comments: [{ userCommentId: '1', content: '来自 acc-1' }] })
    expect(await listWechatComments('acc-2', 'MSG-600')).toEqual([])
    expect(await listWechatComments('acc-1', 'MSG-OTHER')).toEqual([])
    expect(await listWechatComments('acc-1')).toHaveLength(1)
  })

  test('空留言列表返回零行（平台可能没有留言）', async () => {
    configure()
    const { transport } = commentTransport([{ total: 0, comment_list: [] }])
    const result = await syncWechatComments(CONTEXT, { msgDataId: 'MSG-700' }, deps(transport))
    expect(result.stored).toBe(0)
    expect(result.pages).toBe(1)
  })
})
