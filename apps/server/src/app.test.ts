import { describe, expect, test } from 'bun:test'
import type { AgentRuntimePostgresClient, AgentRuntimeWebAuthResolver } from '@proma/shared/utils'
import { createPromaWebServerApplication } from './app.ts'

describe('Proma Web 服务', () => {
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
