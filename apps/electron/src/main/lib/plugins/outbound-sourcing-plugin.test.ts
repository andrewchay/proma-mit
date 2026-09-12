import { describe, expect, test } from 'bun:test'
import { execute as buildPlan } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_build_keyword_plan/execute'
import { execute as scoreLead } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_score_lead/execute'
import { execute as draftOutreach } from '../../../../default-tools/outbound-sourcing/sourcing/sourcing_draft_outreach/execute'

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

  test('Given 外联信息 When 起草 Then 只返回草稿并明确人工发送边界', async () => {
    const result = await draftOutreach({ company: 'Acme', product: 'goji puree', angle: 'private-label supply' })
    expect(result.content).toContain('Jack')
    expect(result.content).toContain('不发送邮件')
  })
})
