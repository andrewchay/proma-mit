import { expect, test } from 'bun:test'
import { summarizePendingUnknownActions } from './unknown-action-review'
import type { UnknownActionRecord } from './unknown-action-store'

test('Given 未知动作含敏感参数 When 生成设置页摘要 Then 只返回会话与门禁状态索引', () => {
  const record: UnknownActionRecord = {
    id: 'action-1',
    sessionId: 'session-1',
    actionKey: 'mcp:hash-secret-parameters',
    tool: 'McpTool',
    detail: { token: 'must not escape', payload: 'private' },
    reason: 'error includes private endpoint',
    createdAt: '2026-10-31T00:00:00.000Z',
    status: 'pending',
    acknowledgedAt: '2026-10-31T00:01:00.000Z',
    resolution: 'private user evidence',
  }

  expect(summarizePendingUnknownActions([record])).toEqual([{
    id: 'action-1',
    sessionId: 'session-1',
    tool: 'McpTool',
    createdAt: '2026-10-31T00:00:00.000Z',
    acknowledgedAt: '2026-10-31T00:01:00.000Z',
  }])
})
