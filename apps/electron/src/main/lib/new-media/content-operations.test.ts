import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeNewMediaDb } from './new-media-sqlite-store'
import { createContentDraft, getPublicationJob, resetContentOperationsForTests, schedulePublication } from './content-operations'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-new-media-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { await resetContentOperationsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('新媒体内容运营', () => {
  test('为每个平台创建差异化本地草稿', async () => {
    const draft = await createContentDraft('秋季新品体验分享 #秋日好物', ['xiaohongshu', 'wechat-official-account'])
    expect(draft.platformCopies.xiaohongshu?.title.length).toBeLessThanOrEqual(20)
    expect(draft.platformCopies['wechat-official-account']?.body).toContain('导读')
  })

  test('排程持久化并始终进入待审批状态', async () => {
    const draft = await createContentDraft('新品内容', ['xiaohongshu'])
    const job = await schedulePublication({ draftId: draft.id, platform: 'xiaohongshu', accountId: 'brand-xhs', scheduledAt: Date.now() + 60_000 })
    expect(job.status).toBe('pending_approval')
    closeNewMediaDb()
    expect(await getPublicationJob(job.id)).toEqual(job)
  })

  test('拒绝过去的发布时间', async () => {
    const draft = await createContentDraft('新品内容', ['xiaohongshu'])
    await expect(schedulePublication({ draftId: draft.id, platform: 'xiaohongshu', accountId: 'brand-xhs', scheduledAt: Date.now() - 1 })).rejects.toThrow('发布时间必须在未来')
  })
})
