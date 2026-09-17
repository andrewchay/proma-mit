import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PlatformAdapterError } from '../platform-adapter'
import { saveWechatDirectCredential } from './wechat-direct-credential'
import { clearWechatTokenCache, type WechatTokenTransport } from './wechat-direct-token-service'
import { createWechatDraft, type WechatDraftTransport } from './wechat-direct-draft-service'
import {
  WECHAT_PUBLISH_STATUS_MAP,
  findActivePublishForDraft,
  getSubmittingCount,
  getWechatPublish,
  listWechatPublishes,
  mapPlatformPublishStatus,
  pollWechatPublishStatus,
  reconcileWechatSubmit,
  submitWechatPublish,
  type WechatPublishTransport,
} from './wechat-direct-publish-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const REF = 'ref-publish'
const CONTEXT = { credentialRef: REF, accountId: 'acc-1' }

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-publish-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { clearWechatTokenCache(); await clearNewMediaRecordsForTests() })
afterAll(() => { clearWechatTokenCache(); closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

const tokenTransport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-PUB', expires_in: 7200 }) })

function publishTransport(routes: { submit?: unknown; get?: unknown }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const transport: WechatPublishTransport = async (input) => {
    calls.push({ url: input.url, body: JSON.parse(input.body) as Record<string, unknown> })
    const endpoint = input.url.split('?')[0] ?? ''
    const body = endpoint.endsWith('/freepublish/submit') ? routes.submit : routes.get
    return { status: 200, text: async () => JSON.stringify(body ?? {}) }
  }
  return { transport, calls }
}

const deps = (transport: WechatPublishTransport) => ({ publishTransport: transport, token: { transport: tokenTransport } })

async function seedDraft(): Promise<string> {
  saveWechatDirectCredential(REF, { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
  const draftTransport: WechatDraftTransport = async () => ({ status: 200, text: async () => JSON.stringify({ media_id: 'DRAFT-PUB-1' }) })
  const draft = await createWechatDraft(CONTEXT, {
    articles: [{ title: '待发布内容', content: '<p>正文</p>', thumbMediaId: 'MEDIA-COVER' }],
  }, { draftTransport, token: { transport: tokenTransport } })
  return draft.id
}

describe('P2-05 提交语义', () => {
  test('提交成功只代表受理，状态为 publishing 并保存 publish_id', async () => {
    const draftId = await seedDraft()
    const { transport, calls } = publishTransport({ submit: { publish_id: 'PUB-123' } })
    const record = await submitWechatPublish(CONTEXT, { draftId }, deps(transport))

    expect(record.status).toBe('publishing')
    expect(record.publishId).toBe('PUB-123')
    expect(record.platformMediaId).toBe('DRAFT-PUB-1')
    expect(record.publishedAt).toBeUndefined()
    expect(record.transitions[0]?.note).toContain('提交成功不等于发布成功')
    expect(calls[0]?.url).toContain('/cgi-bin/freepublish/submit?access_token=')
    expect(calls[0]?.body.media_id).toBe('DRAFT-PUB-1')
  })

  test('平台未返回 publish_id 时按结果未知处理并禁止重复提交', async () => {
    const draftId = await seedDraft()
    const { transport } = publishTransport({ submit: {} })
    await expect(submitWechatPublish(CONTEXT, { draftId }, deps(transport))).rejects.toThrow('无法确认是否受理')

    const records = await listWechatPublishes()
    expect(records[0]?.status).toBe('unknown')
    expect(records[0]?.submitOutcomeUnknown).toBe(true)
    expect(records[0]?.failureCode).toBe('missing_publish_id')

    await expect(submitWechatPublish(CONTEXT, { draftId }, deps(transport))).rejects.toThrow('请先对账确认后再决定是否重新提交')
  })

  test('平台明确拒绝属于已确认失败，不写未知状态', async () => {
    const draftId = await seedDraft()
    const { transport } = publishTransport({ submit: { errcode: 48001, errmsg: 'api unauthorized' } })
    await expect(submitWechatPublish(CONTEXT, { draftId }, deps(transport))).rejects.toThrow('没有发布接口权限')
    expect(await listWechatPublishes()).toEqual([])
  })

  test('网络类失败按结果未知处理，避免重复发布', async () => {
    const draftId = await seedDraft()
    const failing: WechatPublishTransport = async () => { throw new Error('socket hang up') }
    await expect(submitWechatPublish(CONTEXT, { draftId }, deps(failing))).rejects.toThrow('socket hang up')
    const record = (await listWechatPublishes())[0]
    expect(record?.status).toBe('unknown')
    expect(record?.submitOutcomeUnknown).toBe(true)
  })
})

describe('P2-05 重复提交幂等', () => {
  test('同一草稿已有未终结发布时直接返回原记录，不再出网', async () => {
    const draftId = await seedDraft()
    const { transport, calls } = publishTransport({ submit: { publish_id: 'PUB-1' } })
    const first = await submitWechatPublish(CONTEXT, { draftId }, deps(transport))
    const second = await submitWechatPublish(CONTEXT, { draftId }, deps(transport))

    expect(second.id).toBe(first.id)
    expect(second.publishId).toBe('PUB-1')
    expect(calls).toHaveLength(1)

    const active = await findActivePublishForDraft('acc-1', draftId)
    expect(active?.id).toBe(first.id)
    expect(getSubmittingCount()).toBe(0)
  })

  test('并发提交同一草稿只出网一次', async () => {
    const draftId = await seedDraft()
    let releases: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releases = resolve })
    let calls = 0
    const transport: WechatPublishTransport = async () => {
      calls += 1
      await gate
      return { status: 200, text: async () => JSON.stringify({ publish_id: 'PUB-CONCURRENT' }) }
    }
    const pending = Promise.allSettled([
      submitWechatPublish(CONTEXT, { draftId }, deps(transport)),
      submitWechatPublish(CONTEXT, { draftId }, deps(transport)),
    ])
    releases?.()
    const results = await pending
    expect(calls).toBe(1)
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item) => item.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(getSubmittingCount()).toBe(0)
    expect((await listWechatPublishes())).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
  })

  test('未同步或已删除的草稿不能发布', async () => {
    saveWechatDirectCredential(REF, { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
    await expect(submitWechatPublish(CONTEXT, { draftId: 'missing' }, {})).rejects.toThrow('微信草稿不存在')

    const draftTransport: WechatDraftTransport = async () => ({ status: 200, text: async () => JSON.stringify({ media_id: 'DRAFT-DEL' }) })
    const draft = await createWechatDraft(CONTEXT, { articles: [{ title: 'x', content: '<p>y</p>', thumbMediaId: 'M' }] }, { draftTransport, token: { transport: tokenTransport } })
    const { putNewMediaRecord } = await import('../new-media-sqlite-store')
    await putNewMediaRecord('wechat-draft', { ...draft, status: 'deleted' as const })
    await expect(submitWechatPublish(CONTEXT, { draftId: draft.id }, {})).rejects.toThrow('草稿已删除，不能发布')
  })
})

describe('P2-05 平台状态映射', () => {
  test('已知状态映射正确，未映射取值一律 unknown', () => {
    expect(mapPlatformPublishStatus(0).status).toBe('published')
    expect(mapPlatformPublishStatus(1).status).toBe('publishing')
    expect(mapPlatformPublishStatus(4).status).toBe('rejected')
    expect(mapPlatformPublishStatus(5).status).toBe('deleted')
    expect(mapPlatformPublishStatus(99).status).toBe('unknown')
    expect(mapPlatformPublishStatus(99).label).toContain('99')
    expect(mapPlatformPublishStatus(undefined).status).toBe('unknown')
    // 映射表必须标注为本地快照
    expect(WECHAT_PUBLISH_STATUS_MAP.source).toContain('需在真机验收时重新核对')
  })

  test('轮询只在平台明确成功时写入发布时间', async () => {
    const draftId = await seedDraft()
    const submit = publishTransport({ submit: { publish_id: 'PUB-2' } })
    const record = await submitWechatPublish(CONTEXT, { draftId }, deps(submit.transport))

    const polling = publishTransport({ get: { publish_id: 'PUB-2', publish_status: 1 } })
    const publishing = await pollWechatPublishStatus(CONTEXT, record.id, deps(polling.transport))
    expect(publishing.status).toBe('publishing')
    expect(publishing.platformStatus).toBe(1)
    expect(publishing.publishedAt).toBeUndefined()

    const success = publishTransport({ get: { publish_id: 'PUB-2', publish_status: 0, article_id: 'ART-1', article_detail: { item: [{ article_url: 'https://mp.weixin.qq.com/s/abc' }] } } })
    const published = await pollWechatPublishStatus(CONTEXT, record.id, deps(success.transport))
    expect(published.status).toBe('published')
    expect(published.articleUrl).toBe('https://mp.weixin.qq.com/s/abc')
    expect(published.articleId).toBe('ART-1')
    expect(published.publishedAt).toBeDefined()
    // 转换链只记录状态变化，重复的 publishing 不重复入链
    expect(published.transitions.map((item) => item.to)).toEqual(['publishing', 'published'])
  })

  test('平台审核不通过与失败分别落状态并记录失败码', async () => {
    const draftId = await seedDraft()
    const submit = publishTransport({ submit: { publish_id: 'PUB-3' } })
    const record = await submitWechatPublish(CONTEXT, { draftId }, deps(submit.transport))

    const rejected = publishTransport({ get: { publish_status: 4, fail_idx: [0] } })
    const result = await pollWechatPublishStatus(CONTEXT, record.id, deps(rejected.transport))
    expect(result.status).toBe('rejected')
    expect(result.failureCode).toBe('platform_status_4')
    expect(result.failIndices).toEqual([0])
    expect(result.publishedAt).toBeUndefined()
  })

  test('缺少 publish_id 时拒绝轮询', async () => {
    const draftId = await seedDraft()
    const { transport } = publishTransport({ submit: {} })
    await submitWechatPublish(CONTEXT, { draftId }, deps(transport)).catch(() => undefined)
    const record = (await listWechatPublishes())[0]
    await expect(pollWechatPublishStatus(CONTEXT, record?.id ?? '', deps(transport))).rejects.toThrow('缺少 publish_id')
  })
})

describe('P2-05 提交对账', () => {
  test('对账确认已受理时需要 publish_id 才能进入查询状态', async () => {
    const draftId = await seedDraft()
    const failing: WechatPublishTransport = async () => { throw new Error('timeout') }
    await submitWechatPublish(CONTEXT, { draftId }, deps(failing)).catch(() => undefined)
    const record = (await listWechatPublishes())[0]

    const withoutId = await reconcileWechatSubmit(CONTEXT, record?.id ?? '', { platformAccepted: true, note: '后台看到发布中' })
    expect(withoutId.status).toBe('unknown')
    expect(withoutId.submitOutcomeUnknown).toBe(true)

    const withId = await reconcileWechatSubmit(CONTEXT, record?.id ?? '', { platformAccepted: true, publishId: 'PUB-9', note: '后台拿到 publish_id' })
    expect(withId.status).toBe('publishing')
    expect(withId.publishId).toBe('PUB-9')
    expect(withId.submitOutcomeUnknown).toBe(false)
  })

  test('对账确认未受理后可以重新提交', async () => {
    const draftId = await seedDraft()
    const failing: WechatPublishTransport = async () => { throw new Error('timeout') }
    await submitWechatPublish(CONTEXT, { draftId }, deps(failing)).catch(() => undefined)

    const record = (await listWechatPublishes())[0]
    await expect(reconcileWechatSubmit(CONTEXT, record?.id ?? '', { platformAccepted: true, note: '' })).rejects.toThrow('对账说明不能为空')

    const reconciled = await reconcileWechatSubmit(CONTEXT, record?.id ?? '', { platformAccepted: false, note: '后台无该次发布' })
    expect(reconciled.status).toBe('failed')
    expect(reconciled.submitOutcomeUnknown).toBe(false)

    const success = publishTransport({ submit: { publish_id: 'PUB-NEW' } })
    const resubmitted = await submitWechatPublish(CONTEXT, { draftId }, deps(success.transport))
    expect(resubmitted.publishId).toBe('PUB-NEW')
    expect(resubmitted.status).toBe('publishing')
    await expect(reconcileWechatSubmit(CONTEXT, resubmitted.id, { platformAccepted: false, note: 'x' })).rejects.toThrow('不需要对账')
  })

  test('跨账号无法查询或对账他人的发布', async () => {
    const draftId = await seedDraft()
    const submit = publishTransport({ submit: { publish_id: 'PUB-OWN' } })
    const record = await submitWechatPublish(CONTEXT, { draftId }, deps(submit.transport))
    const other = { credentialRef: REF, accountId: 'acc-2' }
    await expect(pollWechatPublishStatus(other, record.id, deps(submit.transport))).rejects.toThrow('不属于当前账号')
    await expect(reconcileWechatSubmit(other, record.id, { platformAccepted: false, note: 'x' })).rejects.toThrow('不属于当前账号')
  })

  test('发布记录保存在本地并可跨读取查询', async () => {
    const draftId = await seedDraft()
    const submit = publishTransport({ submit: { publish_id: 'PUB-PERSIST' } })
    const record = await submitWechatPublish(CONTEXT, { draftId }, deps(submit.transport))
    closeNewMediaDb()
    expect((await getWechatPublish(record.id))?.publishId).toBe('PUB-PERSIST')
    expect((await listWechatPublishes('acc-1')).map((item) => item.id)).toEqual([record.id])
    expect(await listWechatPublishes('acc-2')).toEqual([])
  })
})
