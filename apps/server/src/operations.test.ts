import { describe, expect, test } from 'bun:test'
import { HttpOperationsReporter, redactOperationalError } from './operations.ts'

describe('企业运维出站', () => {
  test('given an audit record when reporting to SIEM then it sends only structured metadata', async () => {
    const sent: unknown[] = []
    const reporter = new HttpOperationsReporter({ siemWebhookUrl: 'https://siem.example.test/events', fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 202 })
    } })
    await reporter.reportAudit({ tenantId: 'tenant', userId: 'user', action: 'POST /agent/sessions', resource: '/agent/sessions', result: 'success' })
    expect(sent).toEqual([{ type: 'audit', record: { tenantId: 'tenant', userId: 'user', action: 'POST /agent/sessions', resource: '/agent/sessions', result: 'success' } }])
  })

  test('given a provider failure when creating operations payload then secret-like values are redacted', () => {
    expect(redactOperationalError('Authorization: Bearer secret-token api_key=abc')).toContain('[redacted]')
    expect(redactOperationalError('Authorization: Bearer secret-token api_key=abc')).not.toContain('secret-token')
  })
})
