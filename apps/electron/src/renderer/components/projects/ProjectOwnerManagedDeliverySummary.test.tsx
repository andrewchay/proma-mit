import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectOwnerManagedDeliverySummary } from './ProjectOwnerDeliveryConversation'

test('Given Owner已安排团队 When向用户确认执行范围 Then只展示成果、资料边界和共享预算', () => {
  const preview = {
    projections: [{
      stepKey: 'research-step',
      title: '整理研究结果',
      outcome: '交付可复核的研究报告',
      acceptanceCriteria: ['结论有来源', '标出未知项'],
      assignee: { displayName: '内部执行员工' },
      dependencies: ['internal-dependency'],
    }],
    preparation: {
      input: { maxCostMicros: 1500000, expiresAt: Date.UTC(2030, 0, 1), maxRuns: 9, maxRework: 3 },
      source: {
        knowledgeSources: [{ name: '已授权资料' }],
        developmentScope: { allowedPaths: ['reports/final.md'] },
        workspaceName: '内部工作区',
        modelId: 'internal-model',
        reviewerEmployeeName: '内部Reviewer',
      },
    },
  } as never
  const html = renderToStaticMarkup(createElement(ProjectOwnerManagedDeliverySummary, { preview }))

  for (const text of ['整理研究结果', '交付可复核的研究报告', '结论有来源', '已授权资料', '代码修改限于本次确认的项目范围', '1.5 美元'])
    expect(html).toContain(text)
  for (const text of ['内部执行员工', 'internal-dependency', 'reports/final.md', '最多 9 次', '3 次返工', '内部工作区', 'internal-model', '内部Reviewer'])
    expect(html).not.toContain(text)
})
