import { describe, expect, test } from 'bun:test'
import { PostgresAuditLog } from './audit.ts'

describe('P4 audit log', () => {
  test('only appends metadata and never requires request payloads', async () => {
    const calls: readonly unknown[][] = []
    const audit = new PostgresAuditLog({ query: async (_sql, params: readonly unknown[] = []) => {
      ;(calls as unknown[][]).push([...params])
      return { rows: [] }
    } })
    await audit.append({ tenantId: 'tenant', userId: 'user', action: 'POST /agent/sessions', resource: '/agent/sessions', result: 'success', requestId: 'request' })
    expect(calls[0]).toContain('POST /agent/sessions')
    expect(calls[0]).not.toContain('api-key')
  })

  test('scopes audit queries and caps result size', async () => {
    let params: readonly unknown[] = []
    const audit = new PostgresAuditLog({ query: async (_sql, next: readonly unknown[] = []) => {
      params = next
      return { rows: [] }
    } })
    await audit.list({ tenantId: 'tenant', userId: 'user', action: 'POST /agent/sessions', limit: 999 })
    expect(params).toEqual(['tenant', 'user', 'POST /agent/sessions', null, null, null, null, 500])
  })
})
