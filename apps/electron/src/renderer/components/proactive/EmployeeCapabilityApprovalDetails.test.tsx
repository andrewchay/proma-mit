import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProactiveApproval } from '@gravitas/shared'
import { EmployeeCapabilityApprovalDetails } from './EmployeeCapabilityApprovalDetails'

test('Given 历史审批标记独立 When 展示 Then 说明声明尚未核验而不是当作事实', () => {
  const approval: ProactiveApproval = { id: 'a', sourceType: 'employee_capability', title: '候选', summary: '', status: 'pending', createdAt: 1, proposedChange: { type: 'employee_capability_adopt', agentId: 'e', scope: 'role', versionNumber: 1, content: '内容', contentHash: 'hash', judgeKind: 'llm', judgeIndependent: true } }
  const markup = renderToStaticMarkup(createElement(EmployeeCapabilityApprovalDetails, { approval }))
  expect(markup).toContain('独立性未核验')
  expect(markup).toContain('历史记录可能缺少完整证据')
  expect(markup).not.toContain('独立性：独立')
})
