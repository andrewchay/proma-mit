import { describe, expect, test } from 'bun:test'
import type { AgentRuntimePostgresClient, AgentRuntimeWebAuthResolver } from '@proma/shared/utils'
import { createPromaWebServerApplication } from './app.ts'

describe('Proma Web 服务', () => {
  test('given a W3C traceparent when completing a request then it returns the trace id for client correlation', async () => {
    const app = createPromaWebServerApplication({ databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }, { postgres: new FakePostgresClient(), auth: () => undefined })
    const response = await app.fetch(new Request('http://server/healthz', {
      headers: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
    }))
    expect(response.headers.get('x-trace-id')).toBe('0123456789abcdef0123456789abcdef')
  })

  test('健康检查不依赖认证，业务接口需要认证', async () => {
    const app = createPromaWebServerApplication({
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      s3: testS3Config,
      envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
      envelopeKeyId: 'test-v1',
      trustedHeaderAuth: false,
      workspaceRoot: '/private/tmp/proma-web-test',
      workerId: 'test-worker',
      taskLeaseMs: 30_000,
    }, {
      postgres: new FakePostgresClient(),
      auth: () => undefined,
    })

    expect((await app.fetch(new Request('http://localhost/healthz'))).status).toBe(200)
    expect((await app.fetch(new Request('http://localhost/agent/sessions'))).status).toBe(401)
  })

  test('开发用可信请求头认证必须显式开启', async () => {
    const auth: AgentRuntimeWebAuthResolver = ({ request }) => {
      const tenantId = request.headers.get('x-proma-tenant-id')
      const userId = request.headers.get('x-proma-user-id')
      return tenantId && userId ? { tenantId, userId } : undefined
    }
    const app = createPromaWebServerApplication({
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      s3: testS3Config,
      envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
      envelopeKeyId: 'test-v1',
      trustedHeaderAuth: true,
      workspaceRoot: '/private/tmp/proma-web-test',
      workerId: 'test-worker',
      taskLeaseMs: 30_000,
    }, { postgres: new FakePostgresClient(), auth })

    const response = await app.fetch(new Request('http://localhost/agent/sessions', {
      headers: { 'x-proma-tenant-id': 'tenant-a', 'x-proma-user-id': 'user-a' },
    }))
    expect(response.status).toBe(200)
  })

  test('会话管理 API 默认排除已归档会话，并支持搜索分页参数', async () => {
    const calls: Array<readonly unknown[]> = []
    const auth: AgentRuntimeWebAuthResolver = () => ({ tenantId: 'tenant-a', userId: 'user-a' })
    const postgres: AgentRuntimePostgresClient = { query: async <Row extends Record<string, unknown>>(_sql: string, params: readonly unknown[] = []) => {
      calls.push(params)
      return { rows: [] as Row[] }
    } }
    const app = createPromaWebServerApplication({
      databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config,
      envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false,
      workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000,
    }, { postgres, auth })

    const response = await app.fetch(new Request('http://localhost/agent/sessions?q=roadmap&page=2&limit=20'))

    expect(response.status).toBe(200)
    expect(calls.some((params) => params.includes(false) && params.includes('roadmap') && params.includes(20) && params.includes(20))).toBe(true)
  })

  test('浏览器工作台可直接访问并包含可恢复的 SSE 消费逻辑', async () => {
    const app = createPromaWebServerApplication({
      databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config,
      envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false,
      workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000,
    }, { postgres: new FakePostgresClient(), auth: () => undefined })

    const response = await app.fetch(new Request('http://localhost/agent/ui'))
    const page = await response.text()

    expect(response.status).toBe(200)
    expect(page).toContain('consumeEvents')
    expect(page).toContain('afterId')
  })

  test('审计导出需要 security-auditor 或 admin 角色', async () => {
    const config = { databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }
    const viewer = createPromaWebServerApplication(config, { postgres: new FakePostgresClient(), auth: () => ({ tenantId: 'tenant-a', userId: 'user-a', roles: ['viewer'] }) })
    const auditor = createPromaWebServerApplication(config, { postgres: new FakePostgresClient(), auth: () => ({ tenantId: 'tenant-a', userId: 'user-a', roles: ['security-auditor'] }) })

    expect((await viewer.fetch(new Request('http://localhost/agent/audit/export'))).status).toBe(403)
    expect((await auditor.fetch(new Request('http://localhost/agent/audit/export'))).status).toBe(200)
  })

  test('运维视图遵循最小权限：viewer 不能读取，operator 仅可访问 metrics 与 recovery', async () => {
    const config = { databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }
    const viewer = createPromaWebServerApplication(config, { postgres: new FakePostgresClient(), auth: () => ({ tenantId: 'tenant-a', userId: 'user-a', roles: ['viewer'] }) })
    const operator = createPromaWebServerApplication(config, { postgres: new FakePostgresClient(), auth: () => ({ tenantId: 'tenant-a', userId: 'user-a', roles: ['operator'] }) })

    expect((await viewer.fetch(new Request('http://localhost/agent/metrics'))).status).toBe(403)
    expect((await viewer.fetch(new Request('http://localhost/agent/recovery/stale-tasks'))).status).toBe(403)
    expect((await operator.fetch(new Request('http://localhost/agent/metrics'))).status).toBe(200)
    expect((await operator.fetch(new Request('http://localhost/agent/recovery/stale-tasks'))).status).toBe(200)
    expect((await operator.fetch(new Request('http://localhost/agent/audit'))).status).toBe(403)
  })
})

class FakePostgresClient implements AgentRuntimePostgresClient {
  async query<Row extends Record<string, unknown>>(): Promise<{ rows: Row[] }> {
    return { rows: [] }
  }
}

const testS3Config = {
  bucket: 'unused',
  region: 'auto',
  maxUploadBytes: 1024,
}
