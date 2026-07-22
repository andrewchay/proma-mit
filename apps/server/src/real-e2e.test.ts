import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { InMemoryAgentRuntimeObjectStore, PostgresTenantRuntimeStore } from '@proma/shared/utils'
import type { ProviderType } from '@proma/shared'
import { createPromaWebServerApplication } from './app.ts'

interface RealCase { provider: ProviderType; apiKey?: string; model: string; baseUrl: string }
const databaseUrl = process.env.PROMA_P2_TEST_DATABASE_URL
const redisUrl = process.env.PROMA_P2_TEST_REDIS_URL
const cases = [
  { provider: 'deepseek', apiKey: process.env.PROMA_AI_SDK_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY, model: process.env.PROMA_AI_SDK_DEEPSEEK_MODEL ?? 'deepseek-chat', baseUrl: process.env.PROMA_AI_SDK_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1' },
  { provider: 'kimi-coding', apiKey: process.env.PROMA_AI_SDK_KIMI_CODING_API_KEY, model: process.env.PROMA_AI_SDK_KIMI_CODING_MODEL ?? 'kimi-for-coding', baseUrl: process.env.PROMA_AI_SDK_KIMI_CODING_BASE_URL ?? 'https://api.kimi.com/coding/v1' },
].filter((entry): entry is RealCase & { apiKey: string } => Boolean(entry.apiKey))
const canRun = process.env.PROMA_WEB_REAL_E2E === '1' && Boolean(databaseUrl && redisUrl && cases.length)

describe.skipIf(!canRun)('服务端 AI SDK 真实 Provider E2E', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const client = { query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({ rows: await sql.unsafe<Row[]>(statement, [...params]) }) }
  const store = new PostgresTenantRuntimeStore(client)
  const scope = { tenantId: `real-${crypto.randomUUID()}`, userId: 'user-a' }
  const app = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: redisUrl!, s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test-v1', trustedHeaderAuth: true, workspaceRoot: '/private/tmp/proma-web-real-e2e', taskLeaseMs: 30_000, workerId: 'real-worker' }, { objectStore: new InMemoryAgentRuntimeObjectStore() })
  const headers = { 'content-type': 'application/json', 'x-proma-tenant-id': scope.tenantId, 'x-proma-user-id': scope.userId }
  beforeAll(async () => { await app.initialize(); await store.setWorkspace({ ...scope, workspaceSlug: 'workspace', cwd: '/ignored', mcpServers: {} }) })
  afterAll(async () => { await app.shutdown(); await sql.close() })
  for (const entry of cases) test(`${entry.provider} 完成服务端 session、SSE 与 usage 写入`, async () => {
    const channelId = `channel-${entry.provider}`
    const sessionId = `session-${entry.provider}`
    await store.setCredential({ ...scope, channelId, provider: entry.provider, apiKey: entry.apiKey, baseUrl: entry.baseUrl, defaultModel: entry.model })
    expect((await app.fetch(new Request('http://server/agent/sessions', { method: 'POST', headers, body: JSON.stringify({ sessionId, workspaceSlug: 'workspace', channelId, modelId: entry.model }) }))).status).toBe(201)
    const started = await app.fetch(new Request(`http://server/agent/sessions/${sessionId}/run`, { method: 'POST', headers, body: JSON.stringify({ prompt: '请只回复 OK。' }) }))
    const { task } = await started.json() as { task: { taskId: string } }
    let terminal
    for (let i = 0; i < 300; i++) {
      const saved = await store.getTask(scope, task.taskId)
      if (saved?.status !== 'running') { terminal = saved; break }
      await Bun.sleep(200)
    }
    if (terminal?.status !== 'completed') console.error(`REAL_E2E_TASK_ERROR ${terminal?.error ?? '任务在 60 秒内未结束'}`)
    expect(terminal?.status, terminal?.error ?? '任务在 60 秒内未结束').toBe('completed')
    const events = await (await app.fetch(new Request(`http://server/agent/sessions/${sessionId}/events`, { headers }))).text()
    expect(events).toContain('text_delta')
  }, 90_000)
})
