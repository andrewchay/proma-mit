import { describe, expect, test } from 'bun:test'
import { PostgresAgentRuntimeInteractionStore } from './interactions.ts'

describe('服务端持久化审批记录', () => {
  test('创建和解析审批记录时保留租户范围及请求数据', async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = []
    const store = new PostgresAgentRuntimeInteractionStore({
      query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params })
        return { rows: [] as Row[] }
      },
    })
    await store.createInteraction({
      tenantId: 'tenant', userId: 'user', taskId: 'task', kind: 'permission',
      request: { requestId: 'request', sessionId: 'session', toolName: 'Write', toolInput: { file_path: 'note.txt' }, description: '写入文件', dangerLevel: 'normal' },
    })
    expect(calls[0]?.sql).toContain('INSERT INTO proma_runtime_interactions')
    expect(calls[0]?.params.slice(0, 6)).toEqual(['tenant', 'user', 'request', 'session', 'task', 'permission'])
  })

  test('仅解析当前租户返回的已解决审批记录', async () => {
    const store = new PostgresAgentRuntimeInteractionStore({
      query: async <Row extends Record<string, unknown>>() => ({ rows: [{
        tenant_id: 'tenant', user_id: 'user', request_id: 'request', session_id: 'session', task_id: 'task', kind: 'permission', status: 'resolved',
        request_json: JSON.stringify({ requestId: 'request', sessionId: 'session', toolName: 'Write', toolInput: {}, description: '写入文件', dangerLevel: 'normal' }),
        response_json: JSON.stringify({ requestId: 'request', behavior: 'allow', alwaysAllow: false }), created_at: 1, expires_at: null, resolved_at: 2,
      } as unknown as Row] }),
    })
    expect(await store.getInteraction({ tenantId: 'tenant', userId: 'user' }, 'request')).toMatchObject({
      tenantId: 'tenant', userId: 'user', status: 'resolved', response: { behavior: 'allow' },
    })
  })
})
