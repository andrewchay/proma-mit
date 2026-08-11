import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  InMemoryAgentRuntimeObjectStore,
  PostgresTenantRuntimeStore,
} from '@gravitas/shared/utils'
import { getAgentCompatibleProviders, PROVIDER_DEFAULT_URLS } from '@gravitas/shared'
import type { AgentRuntimeWebAgentTurnRunner } from '@gravitas/shared/utils'
import { createPromaWebServerApplication } from './app.ts'
import { createOidcJwtAuth } from './jwt-auth.ts'
import { PostgresUsageLedger } from './billing.ts'

/**
 * 生产 OIDC/JWT 端到端测试
 * 补齐 web-e2e / real-e2e（两者都走 trustedHeaderAuth + x-proma-* header）未覆盖的缺口：
 * 用「本地 OIDC issuer(JWKS) 签发的 RS256 JWT」驱动生产鉴权路径，验证 scope 提取、
 * 伪造/过期/缺租户拒绝，以及（可选，需 API key）真实 provider 执行 + usage 落库全链路。
 */

const databaseUrl = process.env.PROMA_P2_TEST_DATABASE_URL
const redisUrl = process.env.PROMA_P2_TEST_REDIS_URL
const canRun = Boolean(databaseUrl && redisUrl)

// ── OIDC 本地 issuer：签发测试 JWT 并伺服 /jwks ──────────────────────────────
interface OidcIssuer {
  jwksUrl: string
  sign: (claims: Record<string, unknown>) => Promise<string>
  stop: () => void
}
type Jwk = JsonWebKey & { kid: string; kty: string }

async function startOidcIssuer(): Promise<OidcIssuer> {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey) as Jwk
  jwk.kid = 'oidc-test-key-1'
  jwk.kty = 'RSA'
  const issuer = 'https://oidc.example.test'
  const jwksPayload = JSON.stringify({ keys: [jwk] })
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(jwksPayload, { headers: { 'content-type': 'application/json' } }),
  })
  return {
    jwksUrl: `http://127.0.0.1:${server.port}/jwks`,
    sign: async (claims) => {
      const header = encodeJson({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })
      const body = encodeJson({ iss: issuer, aud: 'proma-web', ...claims })
      const signed = `${header}.${body}`
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(signed))
      return `${signed}.${toBase64Url(new Uint8Array(signature))}`
    },
    stop: () => server.stop(true),
  }
}

function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}
function toBase64Url(value: Uint8Array): string {
  return value.toBase64().replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

// ── 真实 provider 矩阵（复用 real-e2e 定义，需 PROMA_WEB_REAL_E2E=1 + API key）──
interface RealCase { provider: string; apiKeyEnv: string; model: string; baseUrl: string }
const matrix: RealCase[] = [
  { provider: 'anthropic', apiKeyEnv: 'PROMA_AI_SDK_ANTHROPIC_API_KEY', model: 'claude-3-5-haiku-latest', baseUrl: PROVIDER_DEFAULT_URLS.anthropic },
  { provider: 'google', apiKeyEnv: 'PROMA_AI_SDK_GOOGLE_API_KEY', model: 'gemini-3.5-flash', baseUrl: PROVIDER_DEFAULT_URLS.google },
  { provider: 'openai', apiKeyEnv: 'PROMA_AI_SDK_OPENAI_API_KEY', model: 'gpt-4o-mini', baseUrl: PROVIDER_DEFAULT_URLS.openai },
  { provider: 'deepseek', apiKeyEnv: 'PROMA_AI_SDK_DEEPSEEK_API_KEY', model: 'deepseek-chat', baseUrl: PROVIDER_DEFAULT_URLS.deepseek },
]
const realCases = matrix
  .map((entry) => ({ ...entry, apiKey: process.env[entry.apiKeyEnv] ?? process.env[`${entry.apiKeyEnv.split('_').pop()}_API_KEY`] ?? undefined }))
  .filter((entry): entry is RealCase & { apiKey: string } => Boolean(entry.apiKey))
const canReal = process.env.PROMA_WEB_REAL_E2E === '1' && Boolean(databaseUrl && redisUrl && realCases.length)

describe.skipIf(!canRun)('生产 OIDC/JWT 鉴权链路 E2E', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const client = {
    query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({
      rows: await sql.unsafe<Row[]>(statement, [...params]),
    }),
  }
  const store = new PostgresTenantRuntimeStore(client)
  const scope = { tenantId: `oidc-e2e-${crypto.randomUUID()}`, userId: 'user-a' }
  let issuer: OidcIssuer
  let app: ReturnType<typeof createPromaWebServerApplication>

  beforeAll(async () => {
    issuer = await startOidcIssuer()
    const auth = createOidcJwtAuth({ issuer: 'https://oidc.example.test', audience: 'proma-web', jwksUrl: issuer.jwksUrl })
    app = createPromaWebServerApplication(
      {
        databaseUrl: databaseUrl!,
        redisUrl: redisUrl!,
        s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 },
        envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
        envelopeKeyId: 'test-v1',
        trustedHeaderAuth: false, // 生产模式：不启用 trusted header 旁路
        workspaceRoot: '/private/tmp/proma-web-oidc-e2e',
        taskLeaseMs: 30_000,
        workerId: 'oidc-worker',
      },
      { objectStore: new InMemoryAgentRuntimeObjectStore(), agentTurnRunner: fixtureRunner, auth },
    )
    await app.initialize()
    await store.setWorkspace({ ...scope, workspaceSlug: 'workspace-a', cwd: '/ignored', mcpServers: {} })
    // handleCreateSession 依赖 channel credential + workspace 都存在，这里补齐 fixture 渠道
    await store.setCredential({ ...scope, channelId: 'channel-a', provider: 'openai', apiKey: 'test', baseUrl: 'https://example.invalid', defaultModel: 'test-model' })
  })

  afterAll(async () => {
    await app.shutdown()
    issuer.stop()
    await sql.unsafe('DELETE FROM proma_runtime_schedules WHERE tenant_id = $1 AND user_id = $2', [scope.tenantId, scope.userId])
    await sql.close()
  })

  const bearerHeaders = (token: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })

  test('OIDC 签发的合法 JWT 可建立租户会话并运行（生产鉴权→执行→usage 全链路）', async () => {
    const token = await issuer.sign({ tenant_id: scope.tenantId, sub: scope.userId, exp: futureEpoch(), roles: ['operator'] })
    const headers = bearerHeaders(token)

    const created = await app.fetch(new Request('http://server/agent/sessions', {
      method: 'POST', headers, body: JSON.stringify({ sessionId: 'oidc-session', workspaceSlug: 'workspace-a', channelId: 'channel-a' }),
    }))
    expect(created.status).toBe(201)

    const started = await app.fetch(new Request('http://server/agent/sessions/oidc-session/run', {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }),
    }))
    expect(started.status).toBe(202) // 任务已接受进队列（handleRunSession 语义）
    const { task } = await started.json() as { task: { taskId: string } }
    await waitForTask(task.taskId)

    // 事件含 sdk_message / text_delta（fixture runner 产出）
    const events = await app.fetch(new Request('http://server/agent/sessions/oidc-session/events', { headers }))
    const replay = await readSSEReplay(events)
    expect(replay).toContain('sdk_message')
    expect(replay).toContain('fixture')
  })

  test('伪造签名 / 过期 / 缺租户 / 无 token 均被拒绝', async () => {
    // 无 token
    const noToken = await app.fetch(new Request('http://server/agent/sessions', { method: 'GET', headers: { 'content-type': 'application/json' } }))
    expect(noToken.status).toBe(401)
    // 过期
    const expired = await app.fetch(new Request('http://server/agent/sessions', {
      method: 'GET', headers: bearerHeaders(await issuer.sign({ tenant_id: scope.tenantId, sub: scope.userId, exp: pastEpoch() })),
    }))
    expect(expired.status).toBe(401)
    // 缺 scope（无 tenant_id）
    const missingTenant = await app.fetch(new Request('http://server/agent/sessions', {
      method: 'GET', headers: bearerHeaders(await issuer.sign({ sub: scope.userId, exp: futureEpoch() })),
    }))
    expect(missingTenant.status).toBe(401)
  })

  const fixtureRunner: AgentRuntimeWebAgentTurnRunner = async (input) => {
    input.emit({ kind: 'agent_event', event: { type: 'text_delta', text: 'fixture' } })
    input.emit({ kind: 'agent_event', event: { type: 'complete', stopReason: 'end_turn' } })
    return [{
      type: 'assistant' as const,
      message: { content: [{ type: 'text', text: 'fixture response' }] },
      parent_tool_use_id: null,
      session_id: input.session.sessionId,
    }]
  }

  async function waitForTask(taskId: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const task = await store.getTask(scope, taskId)
      if (task && task.status !== 'running') return
      await Bun.sleep(20)
    }
    throw new Error('任务未在预期时间内完成')
  }

  async function readSSEReplay(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('SSE 响应缺少可读流')
    const first = await reader.read()
    await reader.cancel()
    return new TextDecoder().decode(first.value)
  }
})

// ── 真实 provider 全链路（OIDC 生产鉴权 + 真实执行 + usage 落库）──────────────
describe.skipIf(!canReal)('OIDC + 真实 Provider 矩阵 E2E', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const client = {
    query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({
      rows: await sql.unsafe<Row[]>(statement, [...params]),
    }),
  }
  const store = new PostgresTenantRuntimeStore(client)
  const usageLedger = new PostgresUsageLedger(client, [])
  const scope = { tenantId: `oidc-real-${crypto.randomUUID()}`, userId: 'user-a' }
  let issuer: OidcIssuer
  let app: ReturnType<typeof createPromaWebServerApplication>

  beforeAll(async () => {
    issuer = await startOidcIssuer()
    const auth = createOidcJwtAuth({ issuer: 'https://oidc.example.test', audience: 'proma-web', jwksUrl: issuer.jwksUrl })
    app = createPromaWebServerApplication(
      {
        databaseUrl: databaseUrl!,
        redisUrl: redisUrl!,
        s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 },
        envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
        envelopeKeyId: 'test-v1',
        trustedHeaderAuth: false,
        workspaceRoot: '/private/tmp/proma-web-oidc-real',
        taskLeaseMs: 30_000,
        workerId: 'oidc-real-worker',
      },
      { objectStore: new InMemoryAgentRuntimeObjectStore(), auth },
    )
    await app.initialize()
    await store.setWorkspace({ ...scope, workspaceSlug: 'workspace', cwd: '/ignored', mcpServers: {} })
  })

  afterAll(async () => {
    await app.shutdown()
    issuer.stop()
    await sql.close()
  })

  for (const entry of realCases) {
    test(`[${entry.provider}] OIDC 鉴权通过后完成 session、SSE 与 usage 写入`, async () => {
      const token = await issuer.sign({ tenant_id: scope.tenantId, sub: scope.userId, exp: futureEpoch(), roles: ['operator'] })
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
      const channelId = `channel-${entry.provider}`
      const sessionId = `oidc-session-${entry.provider}`
      await store.setCredential({ ...scope, channelId, provider: entry.provider as never, apiKey: entry.apiKey, baseUrl: entry.baseUrl, defaultModel: entry.model })

      const created = await app.fetch(new Request('http://server/agent/sessions', {
        method: 'POST', headers, body: JSON.stringify({ sessionId, workspaceSlug: 'workspace', channelId, modelId: entry.model }),
      }))
      expect(created.status).toBe(201)

      const started = await app.fetch(new Request(`http://server/agent/sessions/${sessionId}/run`, {
        method: 'POST', headers, body: JSON.stringify({ prompt: '请只回复 OK。' }),
      }))
      const { task } = await started.json() as { task: { taskId: string } }
      let terminal
      for (let i = 0; i < 300; i += 1) {
        const saved = await store.getTask(scope, task.taskId)
        if (saved?.status !== 'running') { terminal = saved; break }
        await Bun.sleep(200)
      }
      if (terminal?.status !== 'completed') console.error(`OIDC_REAL_E2E_TASK_ERROR ${terminal?.error ?? '任务在 60 秒内未结束'}`)
      expect(terminal?.status, terminal?.error ?? '任务在 60 秒内未结束').toBe('completed')

      const events = await (await app.fetch(new Request(`http://server/agent/sessions/${sessionId}/events`, { headers }))).text()
      expect(events).toContain('text_delta')
      expect((await usageLedger.list({ ...scope })).some((record) => record.taskId === task.taskId && record.provider === entry.provider)).toBe(true)
    }, 90_000)
  }
})

function futureEpoch(): number { return Math.floor(Date.now() / 1_000) + 60 }
function pastEpoch(): number { return Math.floor(Date.now() / 1_000) - 60 }
