import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let testDir: string | null = null

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'outbound-mail-test-'))
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('出海邮件发送队列（审批制状态机）', () => {
  test('Given 合法邮件 When 入队 Then 状态为 draft 且不发送', async () => {
    const { queueEmail } = await import('./mail-send-service')
    const item = queueEmail({ to: 'buyer@acme.com', subject: 'Goji supply', body: 'Hello', source: 'agent' })
    expect(item.status).toBe('draft')
    expect(item.source).toBe('agent')
  })

  test('Given 非法收件人或空正文 When 入队 Then 拒绝', async () => {
    const { queueEmail } = await import('./mail-send-service')
    expect(() => queueEmail({ to: 'not-an-email', subject: 's', body: 'b' })).toThrow()
    expect(() => queueEmail({ to: 'a@b.com', subject: '', body: 'b' })).toThrow()
    expect(() => queueEmail({ to: 'a@b.com', subject: 's', body: '  ' })).toThrow()
  })

  test('Given draft 邮件 When 驳回 Then 状态 rejected 且审计有记录', async () => {
    const { queueEmail, rejectEmail, loadOutboxItems } = await import('./mail-send-service')
    const item = queueEmail({ to: 'x@y.com', subject: 'hi', body: 'body' })
    const rejected = rejectEmail(item.id, '价格未确认')
    expect(rejected.status).toBe('rejected')
    expect(rejected.decisionNote).toBe('价格未确认')
    expect(loadOutboxItems().find((i) => i.id === item.id)?.status).toBe('rejected')
    const auditPath = join(testDir!, 'outbound-sourcing', 'mail-audit.jsonl')
    expect(existsSync(auditPath)).toBe(true)
    expect(readFileSync(auditPath, 'utf-8')).toContain('reject')
  })

  test('Given 非 draft 状态 When 再次驳回 Then 报错', async () => {
    const { queueEmail, rejectEmail } = await import('./mail-send-service')
    const item = queueEmail({ to: 'x@y.com', subject: 'hi', body: 'body' })
    rejectEmail(item.id)
    expect(() => rejectEmail(item.id)).toThrow()
  })

  test('Given 已发送邮件 When 查询往来状态 Then 能按公司邮箱检索', async () => {
    const mod = await import('./mail-send-service')
    // 直接构造一条 sent 记录（不连真实 SMTP）
    const queued = mod.queueEmail({ to: 'buyer@acme.com', subject: 'Cold outreach', body: 'Hi', source: 'manual' })
    // 用内部持久化文件模拟发送完成
    const outboxPath = join(testDir!, 'outbound-sourcing', 'mail', 'outbox.jsonl')
    const lines = readFileSync(outboxPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const updated = lines.map((l) => (l.id === queued.id ? { ...l, status: 'sent', sentMessageId: '<sent-1@acme>' } : l))
    writeFileSync(outboxPath, updated.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const status = mod.getMailStatus({ companyEmail: 'BUYER@acme.com' })
    // 验证检索按邮箱大小写不敏感匹配且包含刚入队的邮件
    expect(status.some((s) => s.id === queued.id)).toBe(true)
    expect(status.every((s) => s.to.toLowerCase() === 'buyer@acme.com')).toBe(true)
  })
})

describe('出海邮件收件箱索引', () => {
  test('Given 预置 inbox.jsonl When 查询 Then 按分类与已处理过滤', async () => {
    const mailDir = join(testDir!, 'outbound-sourcing', 'mail')
    mkdirSync(mailDir, { recursive: true })
    const items = [
      { id: 'in-a', messageId: '<1@a>', fromEmail: 'a@b.com', fromName: '', subject: 'Re: Goji', snippet: 's', text: 'full text', html: null, receivedAt: 100, category: 'outreach_reply', threadMailId: null, handled: false },
      { id: 'in-b', messageId: '<2@a>', fromEmail: 'c@d.com', fromName: '', subject: 'Hello', snippet: 's', text: 't2', html: null, receivedAt: 200, category: 'new_inbound', threadMailId: null, handled: true },
    ]
    writeFileSync(join(mailDir, 'inbox.jsonl'), items.map((i) => JSON.stringify(i)).join('\n') + '\n')
    const { listInbox, listInboxSummaries, getInboxItem, markInboxHandled } = await import('./mail-sync-service')
    const all = listInbox()
    expect(all.total).toBe(2)
    expect(all.items[0]?.id).toBe('in-b') // 按时间倒序
    const replies = listInbox({ category: 'outreach_reply' })
    expect(replies.total).toBe(1)
    expect(replies.items[0]?.id).toBe('in-a')
    // 摘要视图不含正文
    const summaries = listInboxSummaries()
    expect(summaries.every((s) => !Object.hasOwn(s, 'text'))).toBe(true)
    // 单封读取与标记
    expect(getInboxItem('in-a')?.text).toBe('full text')
    expect(markInboxHandled('in-a', true)).toBe(true)
    expect(listInbox({ unhandledOnly: true }).total).toBe(0)
  })
})
