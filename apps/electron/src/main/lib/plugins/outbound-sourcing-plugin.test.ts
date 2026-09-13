import { describe, expect, test } from 'bun:test'
import { execute as buildPlan } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_build_keyword_plan/execute'
import { execute as scoreLead } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_score_lead/execute'
import { execute as draftOutreach } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_draft_outreach/execute'
import { execute as draftReply } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_draft_reply/execute'

describe('出海 sourcing 领域包', () => {
  test('Given 产品与目标市场 When 生成计划 Then 输出可执行查询与核验清单', async () => {
    const result = await buildPlan({ product: 'goji puree', markets: ['Germany'], buyer_types: ['brand'] })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('goji puree brand')
    expect(result.content).toContain('verificationChecklist')
  })

  test('Given 已核验的高质量线索 When 评分 Then 标记为 P1', async () => {
    const result = await scoreLead({ company: 'Acme', has_website: true, has_verified_email: true, vertical_match: 'core' })
    expect(result.content).toContain('"priority": "P1"')
  })

  test('Given 外联信息与决策人画像 When 起草 Then 输出画像引导、知识库与人工发送边界', async () => {
    const result = await draftOutreach({
      company: 'Acme',
      product: 'goji puree',
      angle: 'private-label supply',
      decision_maker_role: 'Head of Procurement',
      pain_points: ['organic certification gaps'],
    })
    expect(result.content).toContain('Head of Procurement')
    expect(result.content).toContain('organic certification gaps')
    expect(result.content).toContain('Jack')
    expect(result.content).toContain('不发送邮件')
  })

  test('Given 高意向来信 When 起草回复 Then 允许 Calendly 并生成线程头', async () => {
    const result = await draftReply({
      from_email: 'buyer@acme.com',
      subject: 'Goji inquiry',
      body: 'We would like pricing and samples. Can we schedule a call?',
      message_id: '<a@b>',
    })
    const parsed = JSON.parse(result.content) as { calendlyPolicy: { allowed: boolean }; threadHeaders: { inReplyTo: string; references: string[] }; replySubject: string; systemPrompt: string }
    expect(parsed.calendlyPolicy.allowed).toBe(true)
    expect(parsed.threadHeaders.inReplyTo).toBe('<a@b>')
    expect(parsed.threadHeaders.references).toContain('<a@b>')
    expect(parsed.replySubject).toBe('Re: Goji inquiry')
    // 品牌知识库（redvia.md）已注入 system prompt
    expect(parsed.systemPrompt).toContain('Redvia')
    expect(parsed.systemPrompt).toContain('Calendly')
  })

  test('Given 低意向来信 When 起草回复 Then 禁止 Calendly', async () => {
    const result = await draftReply({ from_email: 'x@y.com', subject: 'hi', body: 'just saying hello' })
    const parsed = JSON.parse(result.content) as { calendlyPolicy: { allowed: boolean } }
    expect(parsed.calendlyPolicy.allowed).toBe(false)
  })
})
