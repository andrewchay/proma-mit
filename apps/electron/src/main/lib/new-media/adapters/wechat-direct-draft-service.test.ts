import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WechatDraftArticle } from '@gravitas/shared'
import { PlatformAdapterError } from '../platform-adapter'
import { saveWechatDirectCredential } from './wechat-direct-credential'
import { clearWechatTokenCache, type WechatTokenTransport } from './wechat-direct-token-service'
import {
  WECHAT_DRAFT_LIMITS,
  WECHAT_DRAFT_LIMITS as LIMITS,
  createWechatDraft,
  deleteWechatDraft,
  getWechatDraft,
  listWechatDrafts,
  precheckWechatDraftArticles,
  pullWechatDraftFromPlatform,
  updateWechatDraft,
  type WechatDraftTransport,
} from './wechat-direct-draft-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REF = 'ref-draft'
const CONTEXT = { credentialRef: REF, accountId: 'acc-1' }

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-draft-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearWechatTokenCache(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearWechatTokenCache(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

function article(overrides: Partial<WechatDraftArticle> = {}): WechatDraftArticle {
  return {
    title: '秋日新品上架',
    content: '<p>正文内容</p>',
    thumbMediaId: 'MEDIA-COVER',
    digest: '一句话摘要',
    ...overrides,
  }
}

const tokenTransport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-DRAFT', expires_in: 7200 }) })

/**
 * 假草稿传输层：按端点返回预置响应，并记录请求体以便断言。
 */
function draftTransport(routes: {
  add?: unknown
  update?: unknown
  get?: unknown
  delete?: unknown
}) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const transport: WechatDraftTransport = async (input) => {
    const parsed = JSON.parse(input.body) as Record<string, unknown>
    calls.push({ url: input.url, body: parsed, headers: input.headers })
    const endpoint = input.url.split('?')[0] ?? ''
    const body = endpoint.endsWith('/draft/add') ? routes.add
      : endpoint.endsWith('/draft/update') ? routes.update
        : endpoint.endsWith('/draft/get') ? routes.get
          : routes.delete
    return { status: 200, text: async () => JSON.stringify(body ?? {}) }
  }
  return { transport, calls }
}

function configure(): void {
  saveWechatDirectCredential(REF, { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
}

async function createDraft(transport: WechatDraftTransport, articles = [article()], now = 1_000) {
  return createWechatDraft(CONTEXT, { articles, localDraftId: 'local-draft-1', now }, { draftTransport: transport, token: { transport: tokenTransport } })
}

describe('P2-04 草稿预检', () => {
  test('保留字与空值问题一次列出', () => {
    expect(precheckWechatDraftArticles([article()]).ok).toBe(true)
    expect(precheckWechatDraftArticles([]).problems[0]).toContain('至少需要一篇图文')
    const bad = precheckWechatDraftArticles([article({ title: '', content: '', thumbMediaId: undefined })])
    expect(bad.ok).toBe(false)
    expect(bad.problems.join()).toContain('缺少标题')
    expect(bad.problems.join()).toContain('正文为空')
    expect(bad.problems.join()).toContain('缺少封面素材')
  })

  test('超长字段、脚本与非 http 链接被拒绝', () => {
    const long = precheckWechatDraftArticles([article({ title: 'x'.repeat(LIMITS.titleMaxChars + 1) })])
    expect(long.problems.join()).toContain('标题超过')
    const digest = precheckWechatDraftArticles([article({ digest: 'x'.repeat(LIMITS.digestMaxChars + 1) })])
    expect(digest.problems.join()).toContain('摘要超过')
    const script = precheckWechatDraftArticles([article({ content: '<p>ok</p><script>alert(1)</script>' })])
    expect(script.problems.join()).toContain('<script>')
    const link = precheckWechatDraftArticles([article({ contentSourceUrl: 'javascript:alert(1)' })])
    expect(link.problems.join()).toContain('原文链接必须是 http 或 https')
    const many = precheckWechatDraftArticles(Array.from({ length: LIMITS.maxArticles + 1 }, () => article()))
    expect(many.problems.join()).toContain('最多')
  })

  test('限制数值标注为本地快照，不作为平台承诺', () => {
    expect(WECHAT_DRAFT_LIMITS.source).toContain('需在真机验收时重新核对')
    expect(WECHAT_DRAFT_LIMITS.verifiedAt).toBeTruthy()
  })
})

describe('P2-04 草稿新增与映射', () => {
  test('新增草稿保存本地与平台映射，请求体符合接口约定', async () => {
    configure()
    const { transport, calls } = draftTransport({ add: { media_id: 'DRAFT-1' } })
    const record = await createDraft(transport)

    expect(record.platformMediaId).toBe('DRAFT-1')
    expect(record.localDraftId).toBe('local-draft-1')
    expect(record.status).toBe('synced')
    expect(record.localRevision).toBe(1)
    expect(record.accountId).toBe('acc-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/cgi-bin/draft/add?access_token=')
    expect(calls[0]?.headers['content-type']).toContain('charset=utf-8')
    const articles = calls[0]?.body.articles as Array<Record<string, unknown>>
    expect(articles[0]?.thumb_media_id).toBe('MEDIA-COVER')
    expect(articles[0]?.need_open_comment).toBe(0)
    expect(calls[0]?.body).not.toHaveProperty('access_token')
  })

  test('平台未返回 media_id 时视为失败，不写入本地映射', async () => {
    configure()
    const { transport } = draftTransport({ add: {} })
    await expect(createDraft(transport)).rejects.toThrow('未返回草稿 media_id')
    expect(await listWechatDrafts()).toEqual([])
  })

  test('预检未通过时不出网', async () => {
    configure()
    const { transport, calls } = draftTransport({ add: { media_id: 'DRAFT-X' } })
    await expect(createDraft(transport, [article({ thumbMediaId: undefined })])).rejects.toThrow(/草稿预检未通过/)
    expect(calls).toHaveLength(0)
  })

  test('平台错误被映射为可执行原因', async () => {
    configure()
    const { transport } = draftTransport({ add: { errcode: 48001, errmsg: 'api unauthorized' } })
    const error: Error = await createDraft(transport).then(
      () => { throw new Error('预期创建草稿失败') },
      (caught: Error) => caught,
    )
    expect(error.message).toContain('没有草稿箱接口权限')
    expect(error.message).toContain('48001')
  })
})

describe('P2-04 草稿更新与冲突', () => {
  test('无冲突时更新成功并递增本地修订号', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-2' } })
    const record = await createDraft(add.transport, [article()], 1_000)

    const update = draftTransport({
      update: {},
      get: { news_item: [{ title: '秋日新品上架', content: '<p>正文内容</p>' }], item: [{ update_time: 1_000 }] },
    })
    const updated = await updateWechatDraft(CONTEXT, record.id, { articles: [article({ title: '改后的标题' })], now: 2_000 }, {
      draftTransport: update.transport,
      token: { transport: tokenTransport },
    })

    expect(updated.status).toBe('synced')
    expect(updated.localRevision).toBe(2)
    expect(updated.articles[0]?.title).toBe('改后的标题')
    expect(updated.platformSyncTime).toBe(2_000)
    const updateCall = update.calls.find((call) => call.url.includes('/draft/update'))
    expect(updateCall?.body.media_id).toBe('DRAFT-2')
    expect(updateCall?.body.index).toBe(0)
  })

  test('平台侧被他人修改时阻止更新，并可显式强制覆盖', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-3' } })
    const record = await createDraft(add.transport, [article()], 1_000)

    // 平台返回的 update_time 与本地记录不一致 → 冲突
    const conflict = draftTransport({ update: {}, get: { news_item: [{ title: '别人改过' }], item: [{ update_time: 9_999 }] } })
    const error: Error = await updateWechatDraft(CONTEXT, record.id, { articles: [article({ title: '我的修改' })], now: 2_000 }, {
      draftTransport: conflict.transport,
      token: { transport: tokenTransport },
    }).then(
      () => { throw new Error('预期更新被冲突阻止') },
      (caught: Error) => caught,
    )

    expect(error).toBeInstanceOf(PlatformAdapterError)
    expect(error.message).toContain('已被其他人修改')
    expect(conflict.calls.some((call) => call.url.includes('/draft/update'))).toBe(false)

    const blocked = await getWechatDraft(record.id)
    expect(blocked?.status).toBe('update_conflict')
    expect(blocked?.lastErrorCode).toBe('update_conflict')
    // 冲突时本地内容没有被覆盖
    expect(blocked?.articles[0]?.title).toBe('秋日新品上架')

    const forced = draftTransport({ update: {}, get: { news_item: [], item: [{ update_time: 9_999 }] } })
    const applied = await updateWechatDraft(CONTEXT, record.id, { articles: [article({ title: '我的修改' })], force: true, now: 3_000 }, {
      draftTransport: forced.transport,
      token: { transport: tokenTransport },
    })
    expect(applied.status).toBe('synced')
    expect(applied.articles[0]?.title).toBe('我的修改')
    expect(forced.calls.some((call) => call.url.includes('/draft/update'))).toBe(true)
  })

  test('以平台为准拉取可解决冲突', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-4' } })
    const record = await createDraft(add.transport, [article()], 1_000)
    const pull = draftTransport({ get: { news_item: [{ title: '平台标题', content: '<p>平台正文</p>' }], item: [{ update_time: 7_777 }] } })

    const synced = await pullWechatDraftFromPlatform(CONTEXT, record.id, { draftTransport: pull.transport, token: { transport: tokenTransport } })
    expect(synced.status).toBe('synced')
    expect(synced.articles[0]?.title).toBe('平台标题')
    expect(synced.platformSyncTime).toBe(7_777)
  })

  test('未同步到平台的草稿不能更新', async () => {
    configure()
    const { transport } = draftTransport({ add: { media_id: 'DRAFT-LOCAL' } })
    const record = await createDraft(transport)
    const { putNewMediaRecord } = await import('../new-media-sqlite-store')
    await putNewMediaRecord('wechat-draft', { ...record, platformMediaId: undefined, status: 'local_only' as const })
    await expect(updateWechatDraft(CONTEXT, record.id, { articles: [article()] }, { draftTransport: transport, token: { transport: tokenTransport } })).rejects.toThrow('尚未同步到微信')
  })
})

describe('P2-04 草稿删除与恢复', () => {
  test('删除成功后状态为已删除', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-5' } })
    const record = await createDraft(add.transport)
    const del = draftTransport({ delete: {} })
    const result = await deleteWechatDraft(CONTEXT, record.id, { draftTransport: del.transport, token: { transport: tokenTransport } })
    expect(result.alreadyGone).toBe(false)
    expect(result.record.status).toBe('deleted')
    expect(del.calls[0]?.body.media_id).toBe('DRAFT-5')
  })

  test('平台已不存在该草稿时按幂等成功处理', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-6' } })
    const record = await createDraft(add.transport)
    const del = draftTransport({ delete: { errcode: 40007, errmsg: 'invalid media_id' } })
    const result = await deleteWechatDraft(CONTEXT, record.id, { draftTransport: del.transport, token: { transport: tokenTransport } })
    expect(result.alreadyGone).toBe(true)
    expect(result.record.status).toBe('deleted')
    // 再次删除仍然幂等
    const again = await deleteWechatDraft(CONTEXT, record.id, { draftTransport: del.transport, token: { transport: tokenTransport } })
    expect(again.alreadyGone).toBe(true)
  })

  test('限流失败保留 media_id 并标记 delete_failed，可重试恢复', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-7' } })
    const record = await createDraft(add.transport)

    const failing = draftTransport({ delete: { errcode: 45009, errmsg: 'api freq out of limit' } })
    await expect(deleteWechatDraft(CONTEXT, record.id, { draftTransport: failing.transport, token: { transport: tokenTransport } })).rejects.toThrow(/频率超限/)

    const failed = await getWechatDraft(record.id)
    expect(failed?.status).toBe('delete_failed')
    expect(failed?.lastErrorCode).toBe('temporarily_unavailable')
    expect(failed?.platformMediaId).toBe('DRAFT-7')

    const retry = draftTransport({ delete: {} })
    const recovered = await deleteWechatDraft(CONTEXT, record.id, { draftTransport: retry.transport, token: { transport: tokenTransport } })
    expect(recovered.record.status).toBe('deleted')
    expect(recovered.record.lastErrorCode).toBeUndefined()
  })

  test('已删除的草稿不能再更新', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-8' } })
    const record = await createDraft(add.transport)
    const del = draftTransport({ delete: {} })
    await deleteWechatDraft(CONTEXT, record.id, { draftTransport: del.transport, token: { transport: tokenTransport } })
    await expect(updateWechatDraft(CONTEXT, record.id, { articles: [article()] }, { draftTransport: add.transport, token: { transport: tokenTransport } })).rejects.toThrow('已在微信侧删除')
  })

  test('跨账号访问被拒绝', async () => {
    configure()
    const add = draftTransport({ add: { media_id: 'DRAFT-9' } })
    const record = await createDraft(add.transport)
    const other = { credentialRef: REF, accountId: 'acc-2' }
    await expect(deleteWechatDraft(other, record.id, { draftTransport: add.transport, token: { transport: tokenTransport } })).rejects.toThrow('不属于当前账号')
    await expect(updateWechatDraft(other, record.id, { articles: [article()] }, { draftTransport: add.transport, token: { transport: tokenTransport } })).rejects.toThrow('不属于当前账号')
  })
})
