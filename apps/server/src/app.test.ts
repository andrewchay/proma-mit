import { describe, expect, test } from 'bun:test'
import type { AgentRuntimePostgresClient, AgentRuntimeWebAuthResolver } from '@gravitas/shared/utils'
import { createPromaWebServerApplication } from './app.ts'

describe('Proma Web 服务', () => {
  test('Given Cookie 会话 When 跨站修改资源 Then 拒绝；同源和 Bearer 不受影响', async () => {
    const postgres = new FakePostgresClient()
    postgres.query = async <Row extends Record<string, unknown>>(sql = '') => ({ rows: (sql.includes('FROM proma_runtime_auth_sessions') ? [{ session_id: 'session', tenant_id: 'tenant-a', user_id: 'user-a', roles: '["operator"]', expires_at: Date.now() + 60000 }] : []) as unknown as Row[] })
    const app = createPromaWebServerApplication({ databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, authMode: 'local', publicBaseUrl: 'https://app.example', workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }, { postgres, auth: ({ request }) => request.headers.get('authorization') ? { tenantId: 'tenant-a', userId: 'api-user', roles: ['operator'] } : undefined })
    const request = (headers: Record<string, string>) => new Request('http://internal/agent/tasks/missing/cancel', { method: 'POST', headers })
    expect((await app.fetch(request({ cookie: 'proma_session=session', origin: 'https://attacker.example' }))).status).toBe(403)
    expect((await app.fetch(request({ cookie: 'proma_session=session' }))).status).toBe(403)
    expect((await app.fetch(request({ cookie: 'proma_session=session', origin: 'https://app.example' }))).status).toBe(404)
    expect((await app.fetch(request({ authorization: 'Bearer token' }))).status).toBe(404)
  })
  test('Given OIDC 发起登录 When 回调没有浏览器 Cookie Then 路由拒绝登录', async () => {
    const app = createPromaWebServerApplication({ databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, authMode: 'oidc', secureSessionCookie: true, oidc: { authorizationEndpoint: 'https://idp.example/authorize', tokenEndpoint: 'https://idp.example/token', clientId: 'client', redirectUri: 'https://app.example/auth/oidc/callback' }, workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }, { postgres: new FakePostgresClient() })
    const start = await app.fetch(new Request('https://app.example/auth/oidc/start'))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    expect(start.headers.get('set-cookie')).toContain('__Host-proma_oidc_state=')
    expect((await app.fetch(new Request(`https://app.example/auth/oidc/callback?code=code&state=${state}`))).status).toBe(400)
  })
  test('Given 本机开发显式启用 none When 请求无身份 Then 使用匿名开发会话', async () => {
    const app = createPromaWebServerApplication({ databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, authMode: 'none', workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }, { postgres: new FakePostgresClient() })
    expect((await app.fetch(new Request('http://localhost/agent/sessions'))).status).toBe(200)
  })
  test('Given 可信请求头与 none 同时配置 When 请求缺少身份 Then 不授予匿名管理员', async () => {
    const app = createPromaWebServerApplication({ databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: true, authMode: 'none', workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }, { postgres: new FakePostgresClient() })
    expect((await app.fetch(new Request('http://localhost/agent/sessions'))).status).toBe(401)
    expect((await app.fetch(new Request('http://localhost/agent/sessions', { headers: { 'x-proma-tenant-id': 'tenant-a', 'x-proma-user-id': 'user-a' } }))).status).toBe(200)
  })
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

  test('viewer 与 security-auditor 只能读取，operator 可以执行普通 Agent 操作', async () => {
    const config = { databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }
    const create = (role: 'viewer' | 'security-auditor' | 'operator') => createPromaWebServerApplication(config, {
      postgres: new FakePostgresClient(),
      auth: () => ({ tenantId: 'tenant-a', userId: 'user-a', roles: [role] }),
    })
    const request = () => new Request('http://localhost/agent/tasks/missing/cancel', { method: 'POST' })

    expect((await create('viewer').fetch(request())).status).toBe(403)
    expect((await create('security-auditor').fetch(request())).status).toBe(403)
    // 404 说明请求已通过角色层，之后才因任务不属于当前用户而被拒绝。
    expect((await create('operator').fetch(request())).status).toBe(404)
  })

  test('会话管理 API 默认排除已归档会话，并支持搜索分页参数', async () => {
    const calls: Array<readonly unknown[]> = []
    const auth: AgentRuntimeWebAuthResolver = () => ({ tenantId: 'tenant-a', userId: 'user-a' })
    const postgres = { query: async <Row extends Record<string, unknown>>(_sql: string, params: readonly unknown[] = []) => {
      calls.push(params)
      return { rows: [] as Row[] }
    }, transaction: async (run: (client: AgentRuntimePostgresClient) => Promise<void>) => { await run(postgres) } }
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

  test('账单读取与导出仅允许 admin，并按当前租户用户范围查询', async () => {
    const config = { databaseUrl: 'postgres://unused', redisUrl: 'redis://unused', s3: testS3Config, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: false, workspaceRoot: '/private/tmp/proma-web-test', workerId: 'test-worker', taskLeaseMs: 30_000 }
    const viewer = createPromaWebServerApplication(config, { postgres: new FakePostgresClient(), auth: () => ({ tenantId: 'tenant-a', userId: 'user-a', roles: ['viewer'] }) })
    const admin = createPromaWebServerApplication(config, { postgres: new FakePostgresClient(), auth: () => ({ tenantId: 'tenant-a', userId: 'user-a', roles: ['admin'] }) })

    expect((await viewer.fetch(new Request('http://localhost/agent/billing'))).status).toBe(403)
    expect((await admin.fetch(new Request('http://localhost/agent/billing'))).status).toBe(200)
    const exportResponse = await admin.fetch(new Request('http://localhost/agent/billing/export?format=json'))
    expect(exportResponse.status).toBe(200)
    expect(exportResponse.headers.get('content-disposition')).toContain('proma-billing.json')
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

  test('浏览器 HTML 表单用 urlencoded 提交 /auth/login 能成功（不再 400）', async () => {
    // 构造 local 模式 + localAdmin，模拟私有部署
    const app = createPromaWebServerApplication({
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      s3: testS3Config,
      envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
      envelopeKeyId: 'test-v1',
      trustedHeaderAuth: false,
      authMode: 'local',
      secureSessionCookie: true,
      localAdmin: { username: 'admin', tenantId: 'tenant-a', password: 'pw-test' },
      workspaceRoot: '/private/tmp/proma-web-test',
      workerId: 'test-worker',
      taskLeaseMs: 30_000,
    }, {
      postgres: new FakePostgresClient(),
      auth: () => undefined,
    })

    // 真实浏览器：application/x-www-form-urlencoded，无 JSON content-type
    const res = await app.fetch(new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=admin&password=pw-test',
    }))
    // 登录成功应为 302（重定向到 dashboard）而非 400（请求体必须是 JSON）
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie')).toContain('proma_session=')
    expect(res.headers.get('set-cookie')).toContain('; Secure')
  })

  test('登录页 GET /auth/login 可访问', async () => {
    const app = createPromaWebServerApplication({
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      s3: testS3Config,
      envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
      envelopeKeyId: 'test-v1',
      trustedHeaderAuth: false,
      authMode: 'local',
      localAdmin: { username: 'admin', tenantId: 'tenant-a', password: 'pw-test' },
      workspaceRoot: '/private/tmp/proma-web-test',
      workerId: 'test-worker',
      taskLeaseMs: 30_000,
    }, {
      postgres: new FakePostgresClient(),
      auth: () => undefined,
    })
    const res = await app.fetch(new Request('http://localhost/auth/login'))
    expect(res.status).toBe(200)
    expect((await res.text()).includes('登录')).toBe(true)
  })

  test('GET /auth/status 暴露 authMode（local 模式）', async () => {
    const app = createPromaWebServerApplication({
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      s3: testS3Config,
      envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
      envelopeKeyId: 'test-v1',
      trustedHeaderAuth: false,
      authMode: 'local',
      localAdmin: { username: 'admin', tenantId: 'tenant-a', password: 'pw-test' },
      workspaceRoot: '/private/tmp/proma-web-test',
      workerId: 'test-worker',
      taskLeaseMs: 30_000,
    }, {
      postgres: new FakePostgresClient(),
      auth: () => undefined,
    })
    const res = await app.fetch(new Request('http://localhost/auth/status'))
    expect(res.status).toBe(200)
    const body = await res.json() as { authMode?: string; hasOidc?: boolean }
    expect(body.authMode).toBe('local')
    expect(body.hasOidc).toBe(false)
  })
})

class FakePostgresClient implements AgentRuntimePostgresClient {
  async query<Row extends Record<string, unknown>>(_sql = ''): Promise<{ rows: Row[] }> {
    return { rows: [] }
  }
  async transaction(run: (client: AgentRuntimePostgresClient) => Promise<void>): Promise<void> { await run(this) }
}

const testS3Config = {
  bucket: 'unused',
  region: 'auto',
  maxUploadBytes: 1024,
}
