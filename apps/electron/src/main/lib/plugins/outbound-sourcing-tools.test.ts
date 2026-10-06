import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execute as buildPersona } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_build_persona/execute'
import { execute as searchBuyers } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_search_buyers/execute'
import { execute as outreachMetrics } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_outreach_metrics/execute'

let testDir: string | null = null

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'outbound-tools-test-'))
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  if (testDir) rmSync(testDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('sourcing_build_persona', () => {
  test('Given 采购负责人 When 合成画像 Then 输出关注点、痛点假设与交接口径', async () => {
    const result = await buildPersona({ company: 'Acme Foods', product: 'goji puree', contact_role: 'Head of Procurement' })
    const parsed = JSON.parse(result.content) as {
      persona: { role: string; purchaseConcerns: string[]; painPointHypotheses: string[] }
      handoff: { nextTool: string; fields: { decision_maker_role: string; pain_points: string[] } }
      caveat: string
    }
    expect(parsed.persona.role).toContain('采购')
    expect(parsed.persona.painPointHypotheses.length).toBeGreaterThan(0)
    expect(parsed.handoff.nextTool).toBe('sourcing_draft_outreach')
    expect(parsed.handoff.fields.decision_maker_role).toBe(parsed.persona.role)
    expect(parsed.caveat).toContain('假设')
  })

  test('Given 缺少公司或产品 When 合成画像 Then 报错', async () => {
    expect((await buildPersona({ company: 'Acme' })).isError).toBe(true)
    expect((await buildPersona({ product: 'goji puree' })).isError).toBe(true)
  })
})

describe('sourcing_search_buyers', () => {
  test('Given 缺少产品或市场 When 检索 Then 报错', async () => {
    expect((await searchBuyers({ product: 'goji' })).isError).toBe(true)
    expect((await searchBuyers({ markets: ['Germany'] })).isError).toBe(true)
  })

  test('Given 未配置搜索凭据 When 检索 Then 返回可解释的空结果而非崩溃', async () => {
    const result = await searchBuyers({ product: 'goji puree', markets: ['Germany'], max_queries: 1 })
    expect(result.isError).toBeUndefined()
    const parsed = JSON.parse(result.content) as { queriesExecuted: number; candidateCount: number; failures?: unknown[] }
    expect(parsed.queriesExecuted).toBe(1)
    expect(parsed.candidateCount).toBe(0)
    // 未配置凭据时应给出失败原因列表，便于用户排查
    expect(Array.isArray(parsed.failures)).toBe(true)
  })
})

describe('sourcing_outreach_metrics', () => {
  test('Given 本地队列与来信 When 查询指标 Then 计算回复率与首回时延', async () => {
    const dir = join(testDir!, 'outbound-sourcing', 'mail')
    mkdirSync(dir, { recursive: true })
    const sentAt = Date.UTC(2026, 0, 1, 0, 0, 0)
    const replyAt = sentAt + 6 * 3_600_000 // 6 小时后回复
    const outbox = [
      { id: 'out-1', to: 'buyer@acme.com', subject: 'Cold outreach', body: 'Hi', inReplyTo: null, references: [], status: 'sent', source: 'agent', replyToInboxId: null, createdAt: sentAt, decidedAt: sentAt, decisionNote: null, sentMessageId: '<m1>', error: null },
      { id: 'out-2', to: 'other@corp.com', subject: 'Cold outreach', body: 'Hi', inReplyTo: null, references: [], status: 'draft', source: 'agent', replyToInboxId: null, createdAt: sentAt, decidedAt: null, decisionNote: null, sentMessageId: null, error: null },
    ]
    const inbox = [
      { id: 'in-1', messageId: '<r1>', fromEmail: 'buyer@acme.com', fromName: '', subject: 'Re: Cold outreach', snippet: 's', text: 't', html: null, receivedAt: replyAt, category: 'outreach_reply', threadMailId: 'out-1', handled: false },
    ]
    writeFileSync(join(dir, 'outbox.jsonl'), outbox.map((i) => JSON.stringify(i)).join('\n') + '\n')
    writeFileSync(join(dir, 'inbox.jsonl'), inbox.map((i) => JSON.stringify(i)).join('\n') + '\n')

    const result = await outreachMetrics({ top: 5 })
    const parsed = JSON.parse(result.content) as {
      summary: { sent: number; pending: number; contactedCompanies: number; repliedCompanies: number; replyRate: string; averageFirstReplyLatency: string | null }
      companies: Array<{ email: string; replies: number }>
    }
    expect(parsed.summary.sent).toBe(1)
    expect(parsed.summary.pending).toBe(1)
    expect(parsed.summary.contactedCompanies).toBe(1)
    expect(parsed.summary.repliedCompanies).toBe(1)
    expect(parsed.summary.replyRate).toBe('100%')
    expect(parsed.summary.averageFirstReplyLatency).toContain('小时')
    expect(parsed.companies.find((c) => c.email === 'buyer@acme.com')?.replies).toBe(1)
  })
})
