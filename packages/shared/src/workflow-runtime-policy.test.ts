import { expect, test } from 'bun:test'
import { isWorkflowToolAllowed } from './workflow-runtime-policy'

test('Workflow 运行时只允许显式工具或冻结 MCP 服务器的工具', () => {
  const policy = { allowedTools: ['Read'], mcpServers: [{ name: 'nocobase' }] }
  expect(isWorkflowToolAllowed('Read', policy, ['nocobase'])).toBe(true)
  expect(isWorkflowToolAllowed('mcp__nocobase__create_task', policy, ['nocobase'])).toBe(true)
  expect(isWorkflowToolAllowed('mcp__other__create_task', policy, ['nocobase'])).toBe(false)
  expect(isWorkflowToolAllowed('Write', policy, ['nocobase'])).toBe(false)
})
