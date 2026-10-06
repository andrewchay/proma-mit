/**
 * P2-05 与 P2-06 的组合验证：
 * 审批门控 → 微信发布执行器 → 发布状态机 → 回执与状态查询。
 *
 * 全程不出网：token、草稿与发布三段都注入假传输层。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearControlledActionExecutorsForTests, getControlledActionExecutor } from '../new-media-controlled-executor'
import {
  approveControlledAction,
  executeControlledAction,
  getControlledActionAudit,
  listControlledActions,
  requestControlledAction,
  resetControlledActionsForTests,
} from '../controlled-actions'
import { configureWechatDirectAccount, connectWechatDirectAccount, createNewMediaAccount } from '../new-media-account-service'
import { saveWechatDirectCredential } from './wechat-direct-credential'
import { clearWechatTokenCache, type WechatTokenTransport } from './wechat-direct-token-service'
import { createWechatDraft, type WechatDraftTransport } from './wechat-direct-draft-service'
import { provenanceForUploadedAsset, upsertAssetProvenance } from '../new-media-asset-provenance'
import {
  listWechatPublishes,
  pollWechatPublishStatus,
  registerWechatPublishExecutor,
  resetWechatPublishExecutorDependenciesForTests,
  setWechatPublishExecutorDependenciesForTests,
  type WechatPublishTransport,
} from './wechat-direct-publish-service'
import { clearNewMediaRecordsForTests, closeNewMediaDb } from '../new-media-sqlite-store'

let testDir = ''
const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-e2e-publish-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => {
  clearWechatTokenCache()
  clearControlledActionExecutorsForTests()
  resetWechatPublishExecutorDependenciesForTests()
  await clearNewMediaRecordsForTests()
})
afterAll(() => {
  clearWechatTokenCache()
  clearControlledActionExecutorsForTests()
  closeNewMediaDb()
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

const tokenTransport: WechatTokenTransport = async () => ({ status: 200, text: async () => JSON.stringify({ access_token: 'TOKEN-E2E', expires_in: 7200 }) })

function publishTransport(routes: { submit?: unknown; get?: unknown }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const transport: WechatPublishTransport = async (input) => {
    calls.push({ url: input.url, body: JSON.parse(input.body) as Record<string, unknown> })
    const endpoint = input.url.split('?')[0] ?? ''
    return { status: 200, text: async () => JSON.stringify((endpoint.endsWith('/freepublish/submit') ? routes.submit : routes.get) ?? {}) }
  }
  return { transport, calls }
}

/** 建立已连接的微信账号 + 已同步的草稿，返回草稿 id 与账号 id。 */
async function seedConnectedAccountWithDraft(): Promise<{ accountId: string; draftId: string }> {
  saveWechatDirectCredential('ref-conn', { appId: APP_ID, appSecret: APP_SECRET }, { accessToken: '' })
  const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '品牌服务号' })
  await configureWechatDirectAccount(account.id, {
    appId: APP_ID, appSecret: APP_SECRET, accountType: 'service', verificationStatus: 'verified', ipWhitelistConfigured: true,
  })
  await connectWechatDirectAccount(account.id, { transport: tokenTransport })

  const draftStore = await import('../new-media-sqlite-store')
  const credential = draftStore.putNewMediaRecord
  void credential
  const draftTransport: WechatDraftTransport = async () => ({ status: 200, text: async () => JSON.stringify({ media_id: 'DRAFT-E2E-1' }) })
  const draft = await createWechatDraft(
    { credentialRef: 'ref-conn', accountId: account.id },
    { articles: [{ title: '端到端发布', content: '<p>正文</p>', thumbMediaId: 'MEDIA-E2E' }] },
    { draftTransport, token: { transport: tokenTransport } },
  )
  // 封面素材必须有来源与许可记录，否则发布会被 P4-09 门控阻断。
  await upsertAssetProvenance(provenanceForUploadedAsset({
    assetKey: 'MEDIA-E2E', accountId: account.id, uploadedBy: 'Carol', licenseStatus: 'granted', licenseRef: '自有素材',
  }))
  return { accountId: account.id, draftId: draft.id }
}

describe('P2-05 + P2-06 组合：受控发布全链路', () => {
  test('未经审批的发布不会被提交到平台', async () => {
    const { accountId, draftId } = await seedConnectedAccountWithDraft()
    const { transport, calls } = publishTransport({ submit: { publish_id: 'PUB-E2E' } })
    registerWechatPublishExecutor()
    setWechatPublishExecutorDependenciesForTests({ publishTransport: transport, token: { transport: tokenTransport } })

    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: draftId, accountId, summary: '端到端发布' })
    await expect(executeControlledAction(action.id)).rejects.toThrow('尚未批准')
    expect(calls).toHaveLength(0)
    expect(await listWechatPublishes()).toEqual([])
  })

  test('批准后执行：回执只声明已受理，状态查询才决定是否发布成功', async () => {
    const { accountId, draftId } = await seedConnectedAccountWithDraft()
    const submit = publishTransport({ submit: { publish_id: 'PUB-E2E-2' } })
    registerWechatPublishExecutor()
    setWechatPublishExecutorDependenciesForTests({ publishTransport: submit.transport, token: { transport: tokenTransport } })

    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: draftId, accountId, summary: '端到端发布' })
    await approveControlledAction(action.id)
    const executed = await executeControlledAction(action.id)

    expect(executed.status).toBe('executed')
    expect(executed.receipt?.externalId).toBe('PUB-E2E-2')
    // 回执保留平台侧语义：受理，不是已发布
    expect(executed.receipt?.platformStatus).toBe('publishing')
    expect(executed.receipt?.summary).toContain('等待平台异步结果')

    const publishes = await listWechatPublishes(accountId)
    expect(publishes).toHaveLength(1)
    expect(publishes[0]?.status).toBe('publishing')
    expect(publishes[0]?.publishId).toBe('PUB-E2E-2')
    expect(publishes[0]?.publishedAt).toBeUndefined()

    // 查询到平台明确成功后才算发布完成
    const polling = publishTransport({ get: { publish_status: 0, article_id: 'ART-E2E', article_detail: { item: [{ article_url: 'https://mp.weixin.qq.com/s/e2e' }] } } })
    const polled = await pollWechatPublishStatus({ credentialRef: 'ref-conn', accountId }, publishes[0]?.id ?? '', { publishTransport: polling.transport, token: { transport: tokenTransport } })
    expect(polled.status).toBe('published')
    expect(polled.publishedAt).toBeDefined()
    expect(polled.articleUrl).toBe('https://mp.weixin.qq.com/s/e2e')

    // 同一审批不能再次执行
    await expect(executeControlledAction(action.id)).rejects.toThrow('已执行完成')
    expect(submit.calls).toHaveLength(1)

    const audit = await getControlledActionAudit(action.id)
    expect(audit.map((entry) => entry.event)).toEqual(['requested', 'approved', 'executing', 'executed'])
  })

  test('封面素材缺少许可记录时发布被阻断，且不消耗审批', async () => {
    const { accountId, draftId } = await seedConnectedAccountWithDraft()
    registerWechatPublishExecutor()
    setWechatPublishExecutorDependenciesForTests({ publishTransport: async () => ({ status: 200, text: async () => JSON.stringify({ publish_id: 'SHOULD-NOT-BE-CALLED' }) }), token: { transport: tokenTransport } })
    const { getNewMediaRecord } = await import('../new-media-sqlite-store')
    // 移除封面的来源记录，模拟「素材来历不明」
    const records = await import('../new-media-sqlite-store')
    const list = await (records as unknown as { listNewMediaRecords: (kind: string) => Promise<Array<{ id: string; assetKey: string }>> }).listNewMediaRecords('asset-provenance')
    for (const entry of list) {
      if (entry.assetKey === 'MEDIA-E2E') await records.deleteNewMediaRecord('asset-provenance', entry.id)
    }
    void getNewMediaRecord

    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: draftId, accountId, summary: '素材缺许可' })
    await approveControlledAction(action.id)
    const error: Error = await executeControlledAction(action.id).then(
      () => { throw new Error('预期发布被素材门控阻断') },
      (caught: Error) => caught,
    )
    expect(error.message).toContain('未通过外发检查')
    expect(error.message).toContain('MEDIA-E2E')

    const failed = (await listControlledActions())[0]
    expect(failed?.status).toBe('failed')
    // 阻断发生在任何平台请求之前，属于 not_started：补齐许可后可直接重试
    expect(failed?.failureOutcome).toBe('not_started')
    expect(failed?.retryRequiresReconciliation).toBe(false)
    expect((await listWechatPublishes(accountId)).length).toBe(0)
  })

  test('平台明确拒绝时执行失败可重试，且不会留下未知状态', async () => {
    const { accountId, draftId } = await seedConnectedAccountWithDraft()
    const rejected = publishTransport({ submit: { errcode: 48001, errmsg: 'api unauthorized' } })
    registerWechatPublishExecutor()
    setWechatPublishExecutorDependenciesForTests({ publishTransport: rejected.transport, token: { transport: tokenTransport } })

    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: draftId, accountId, summary: '权限不足' })
    await approveControlledAction(action.id)
    await expect(executeControlledAction(action.id)).rejects.toThrow('没有发布接口权限')

    const failed = (await listControlledActions())[0]
    expect(failed?.status).toBe('failed')
    expect(failed?.failureOutcome).toBe('confirmed_failure')
    expect(failed?.retryRequiresReconciliation).toBe(false)
    expect(await listWechatPublishes(accountId)).toEqual([])
  })

  test('网络失败时标记结果未知并要求先对账，避免重复发布', async () => {
    const { accountId, draftId } = await seedConnectedAccountWithDraft()
    const failing: WechatPublishTransport = async () => { throw new Error('socket hang up') }
    registerWechatPublishExecutor()
    setWechatPublishExecutorDependenciesForTests({ publishTransport: failing, token: { transport: tokenTransport } })

    const action = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: draftId, accountId, summary: '网络异常' })
    await approveControlledAction(action.id)
    await expect(executeControlledAction(action.id)).rejects.toThrow('socket hang up')

    const failed = (await listControlledActions())[0]
    expect(failed?.failureOutcome).toBe('unknown')
    expect(failed?.retryRequiresReconciliation).toBe(true)

    const publishes = await listWechatPublishes(accountId)
    expect(publishes[0]?.status).toBe('unknown')
    expect(publishes[0]?.submitOutcomeUnknown).toBe(true)

    // 未对账前不允许重新提交
    await expect(executeControlledAction(action.id)).rejects.toThrow(/请先对账确认后再重试/)
  })

  test('缺少账号或账号未连接时执行器明确拒绝，不消耗审批之外的操作', async () => {
    registerWechatPublishExecutor()
    expect(getControlledActionExecutor('publish', 'wechat-official-account')).toBeDefined()

    const noAccount = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: 'draft-x', summary: '缺账号' })
    await approveControlledAction(noAccount.id)
    await expect(executeControlledAction(noAccount.id)).rejects.toThrow('未指定账号')

    const account = await createNewMediaAccount({ platform: 'wechat-official-account', displayName: '未连接号' })
    const notConnected = await requestControlledAction({ kind: 'publish', platform: 'wechat-official-account', targetId: 'draft-x', accountId: account.id, summary: '未连接' })
    await approveControlledAction(notConnected.id)
    await expect(executeControlledAction(notConnected.id)).rejects.toThrow(/尚未通过微信侧校验/)
  })
})
