import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PNG } from 'pngjs'
import type { NewMediaConnectedAccount, WechatDraftRecord, WechatMediaAsset } from '@gravitas/shared'
import { buildElectronMock } from '../testing/electron-mock'
mock.module('electron', () => buildElectronMock())
const { createDirectorBrand, createDirectorPlan, confirmDirectorPlan, createDirectorWechatDraft } = await import('./director-workflow')
const { saveDirectorDesign } = await import('./director-design')
const { syncDirectorWechatDraft, confirmWechatDraftNotCreated } = await import('./wechat-director-sync')
const { putNewMediaRecord, closeNewMediaDb } = await import('./new-media-sqlite-store')
let directory = ''
const prior = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(() => { directory = mkdtempSync(join(tmpdir(), 'nm-wechat-sync-')); process.env.PROMA_TEST_CONFIG_DIR = directory })
afterAll(() => { closeNewMediaDb(); if (prior === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = prior; rmSync(directory, { recursive: true, force: true }) })

async function fixture() {
  const brand = await createDirectorBrand('英语品牌', '口语')
  const plan = await createDirectorPlan(brand.id, 'wechat-official-account', '公众号方案')
  await confirmDirectorPlan(plan.id)
  const draft = await createDirectorWechatDraft({ planId: plan.id, title: '标题', body: '正文 <script>\n第二行' })
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }))
  const asset = await saveDirectorDesign(draft.id, '<svg viewBox="0 0 900 383"><rect width="900" height="383"/></svg>', async (_svg, dimensions) => {
    expect(dimensions).toEqual({ width: 900, height: 383 })
    return png
  })
  const now = Date.now()
  const account = { id: `account-${draft.id}`, platform: 'wechat-official-account', status: 'connected', credentialRef: 'fixture', credentialProtection: 'encrypted', wechatDirect: { ipWhitelistConfigured: true }, createdAt: now, updatedAt: now } as NewMediaConnectedAccount
  await putNewMediaRecord('connected-account', account)
  return { draft, asset, account }
}

test('已确认方案和预览封面同步到公众号草稿箱，重复操作不再次请求', async () => {
  const { draft, asset, account } = await fixture()
  let uploads = 0, creations = 0, html = ''
  const deps = {
    upload: async () => { uploads++; return { asset: { currentMediaId: 'media-1' } as WechatMediaAsset, reused: false } },
    createDraft: async (_context: unknown, input: { articles: import('@gravitas/shared').WechatDraftArticle[] }) => {
      creations++; html = input.articles[0]!.content
      const record = { id: 'remote-record', accountId: account.id, localDraftId: draft.id, articles: input.articles, localRevision: 1, status: 'synced', createdAt: Date.now(), updatedAt: Date.now() } as WechatDraftRecord
      return putNewMediaRecord('wechat-draft', record)
    },
  }
  await expect(syncDirectorWechatDraft({ draftId: draft.id, accountId: account.id, assetId: 'old' }, deps)).rejects.toThrow('封面已变化')
  const input = { draftId: draft.id, accountId: account.id, assetId: asset.id }
  const first = await syncDirectorWechatDraft(input, deps)
  const second = await syncDirectorWechatDraft(input, deps)
  expect(first.id).toBe(second.id)
  expect(uploads).toBe(1)
  expect(creations).toBe(1)
  expect(html).toContain('&lt;script&gt;')
  await expect(saveDirectorDesign(draft.id, '<svg viewBox="0 0 1 1"></svg>', async () => Buffer.alloc(0))).rejects.toThrow('已开始同步')
})

test('远端结果未知时不自动重复创建草稿', async () => {
  const { draft, asset, account } = await fixture()
  const input = { draftId: draft.id, accountId: account.id, assetId: asset.id }
  let calls = 0
  const deps = { upload: async () => ({ asset: { currentMediaId: 'media-1' } as WechatMediaAsset, reused: false }), createDraft: async () => { calls++; throw new Error('网络中断') } }
  await expect(syncDirectorWechatDraft(input, deps)).rejects.toThrow('结果未确认')
  await expect(syncDirectorWechatDraft(input, deps)).rejects.toThrow('结果未确认')
  expect(calls).toBe(1)
  await confirmWechatDraftNotCreated(draft.id, account.id)
  await expect(syncDirectorWechatDraft(input, deps)).rejects.toThrow('结果未确认')
  expect(calls).toBe(2)
})

test('素材上传失败时未提交草稿，用户重试可再次尝试上传', async () => {
  const { draft, asset, account } = await fixture()
  const input = { draftId: draft.id, accountId: account.id, assetId: asset.id }
  let calls = 0
  const deps = { upload: async () => { calls++; throw new Error('上传失败') } }
  await expect(syncDirectorWechatDraft(input, deps)).rejects.toThrow('封面上传未完成')
  await expect(syncDirectorWechatDraft(input, deps)).rejects.toThrow('封面上传未完成')
  expect(calls).toBe(2)
})

test('上传进行中请求断开账号时，不再提交草稿', async () => {
  const { draft, asset, account } = await fixture()
  const { disconnectNewMediaAccount } = await import('./new-media-account-service')
  let release!: () => void
  let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let creations = 0
  const pending = syncDirectorWechatDraft({ draftId: draft.id, accountId: account.id, assetId: asset.id }, {
    upload: async () => { started(); await gate; return { asset: { currentMediaId: 'media-1' } as WechatMediaAsset, reused: false } },
    createDraft: async () => { creations++; throw new Error('不应提交') },
  })
  await begun
  const disconnecting = disconnectNewMediaAccount(account.id)
  release()
  await expect(pending).rejects.toThrow('尚未提交公众号草稿')
  expect((await disconnecting).status).toBe('disconnected')
  expect(creations).toBe(0)
})

test('写入创建意图后断开账号时，在平台请求前再次拦截', async () => {
  const { draft, asset, account } = await fixture()
  const { disconnectNewMediaAccount } = await import('./new-media-account-service')
  const { getWechatDirectorSyncStatus } = await import('./wechat-director-sync')
  let release!: () => void
  let started!: () => void
  const begun = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let sent = false
  const pending = syncDirectorWechatDraft({ draftId: draft.id, accountId: account.id, assetId: asset.id }, {
    upload: async () => ({ asset: { currentMediaId: 'media-1' } as WechatMediaAsset, reused: false }),
    createDraft: async (_context, _input, dependencies) => { started(); await gate; dependencies?.beforeRequest?.(); sent = true; throw new Error('不应提交') },
  })
  await begun
  const disconnecting = disconnectNewMediaAccount(account.id)
  release()
  await expect(pending).rejects.toThrow('未提交公众号草稿')
  await disconnecting
  expect(sent).toBe(false)
  expect(await getWechatDirectorSyncStatus(draft.id, account.id)).toBe('not_created')
})
