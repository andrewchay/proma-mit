import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createContentDraft, listPublicationJobs, schedulePublication } from './content-operations'
import { createReplyDraft, ingestEngagement } from './community-listening'
import { approveControlledAction, getControlledActionAudit, requestControlledAction } from './controlled-actions'
import {
  NEW_MEDIA_AUDIT_EVENTS,
  createNewMediaAuditEntry,
  isKnownAuditEvent,
  listNewMediaAudit,
  redactAuditText,
  sanitizeAuditMetadata,
} from './new-media-audit'
import { closeNewMediaDb, getNewMediaSchemaInfo } from './new-media-sqlite-store'

let testDir = ''
beforeAll(() => { testDir = mkdtempSync(join(tmpdir(), 'gravitas-nm-audit-')); process.env.PROMA_TEST_CONFIG_DIR = testDir })
afterEach(async () => { const { clearNewMediaRecordsForTests } = await import('./new-media-sqlite-store'); await clearNewMediaRecordsForTests() })
afterAll(() => { closeNewMediaDb(); delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(testDir, { recursive: true, force: true }) })

describe('新媒体统一审计', () => {
  test('事件字典覆盖七个领域，未登记事件被拒绝', () => {
    expect(Object.keys(NEW_MEDIA_AUDIT_EVENTS).sort()).toEqual(['account', 'community', 'compliance', 'governance', 'handoff', 'import', 'publication'])
    expect(isKnownAuditEvent('handoff', 'prepared')).toBe(true)
    expect(isKnownAuditEvent('handoff', '直接发布')).toBe(false)
    expect(isKnownAuditEvent('publication', 'publication_scheduled')).toBe(true)
  })

  test('写入前脱敏文本与元数据', () => {
    const redacted = redactAuditText('调用失败 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789')
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789')
    expect(redacted).toContain('[已脱敏')

    const metadata = sanitizeAuditMetadata({
      platform: 'xiaohongshu',
      accessToken: 'should-be-dropped',
      clientSecret: 'should-be-dropped',
      cookie: 'should-be-dropped',
      retries: 2,
    })
    expect(metadata).toEqual({ platform: 'xiaohongshu', retries: 2 })
    expect(sanitizeAuditMetadata({ token: 'x' })).toBeUndefined()
  })

  test('创建审计时拒绝敏感字段与未登记事件', async () => {
    expect(() => createNewMediaAuditEntry({ domain: 'governance', event: '未知事件', actor: 'local-user', subjectId: 'a-1', detail: 'x' })).toThrow('未登记的审计事件')
    await expect(createNewMediaAuditEntry({ domain: 'account', event: 'connected', actor: 'local-user', subjectId: 'a-1', detail: 'x' })).resolves.toBeDefined()
  })

  test('排程、互动和审批的状态迁移都在统一审计中留痕，且不含正文', async () => {
    const draft = await createContentDraft('这是一段会被记录但不应进入审计的原始正文', ['xiaohongshu'])
    const job = await schedulePublication({ draftId: draft.id, platform: 'xiaohongshu', accountId: 'account-1', scheduledAt: Date.now() + 3600_000 })
    expect((await listPublicationJobs()).map((item) => item.id)).toEqual([job.id])

    const engagement = await ingestEngagement({ platform: 'xiaohongshu', channel: 'comment', author: '用户A', text: '这个多少钱？' })
    await createReplyDraft(engagement.id)

    const action = await requestControlledAction({ kind: 'publish', platform: 'xiaohongshu', targetId: draft.id, summary: '品牌内容发布' })
    await approveControlledAction(action.id)

    const all = await listNewMediaAudit()
    expect(all.map((entry) => `${entry.domain}/${entry.event}`)).toEqual([
      'publication/publication_scheduled',
      'community/engagement_ingested',
      'community/reply_draft_created',
      'governance/requested',
      'governance/approved',
    ])
    // 正文与用户昵称不进入审计明细。
    const serialized = JSON.stringify(all)
    expect(serialized).not.toContain('这是一段会被记录但不应进入审计的原始正文')
    expect(serialized).not.toContain('这个多少钱')
    expect(serialized).not.toContain('用户A')
    // 同一毫秒内的迁移也能稳定排序。
    const ordinals = all.map((entry) => entry.ordinal)
    expect([...ordinals].sort((left, right) => left - right)).toEqual(ordinals)

    expect((await getControlledActionAudit(action.id)).map((entry) => entry.event)).toEqual(['requested', 'approved'])
  })

  test('审计记录在 schema 注册表中登记，且按领域可检索', async () => {
    const info = await getNewMediaSchemaInfo()
    expect(info.registeredKinds.map((item) => item.kind)).toContain('new-media-audit')
    expect(info.unknownKinds).toEqual([])
    expect(NEW_MEDIA_AUDIT_EVENTS.publication).toContain('publication_scheduled')
    expect((await listNewMediaAudit({ domain: 'governance' })).length).toBe(0)
  })
})
