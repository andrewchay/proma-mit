import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { InMemoryAgentRuntimeObjectStore, PostgresTenantRuntimeStore } from '@proma/shared/utils'
import { getAgentCompatibleProviders, PROVIDER_DEFAULT_URLS } from '@proma/shared'
import type { ProviderType } from '@proma/shared'
import { createPromaWebServerApplication } from './app.ts'
import { PostgresUsageLedger } from './billing.ts'

interface RealCase { provider: ProviderType; apiKeyEnv: string; fallbackApiKeyEnv?: string; modelEnv: string; model: string; baseUrlEnv: string; baseUrl: string }
const databaseUrl = process.env.PROMA_P2_TEST_DATABASE_URL
const redisUrl = process.env.PROMA_P2_TEST_REDIS_URL
const matrix: readonly RealCase[] = [
  { provider: 'anthropic', apiKeyEnv: 'PROMA_AI_SDK_ANTHROPIC_API_KEY', fallbackApiKeyEnv: 'ANTHROPIC_API_KEY', modelEnv: 'PROMA_AI_SDK_ANTHROPIC_MODEL', model: 'claude-3-5-haiku-latest', baseUrlEnv: 'PROMA_AI_SDK_ANTHROPIC_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS.anthropic },
  { provider: 'google', apiKeyEnv: 'PROMA_AI_SDK_GOOGLE_API_KEY', fallbackApiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY', modelEnv: 'PROMA_AI_SDK_GOOGLE_MODEL', model: 'gemini-3.5-flash', baseUrlEnv: 'PROMA_AI_SDK_GOOGLE_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS.google },
  { provider: 'openai', apiKeyEnv: 'PROMA_AI_SDK_OPENAI_API_KEY', fallbackApiKeyEnv: 'OPENAI_API_KEY', modelEnv: 'PROMA_AI_SDK_OPENAI_MODEL', model: 'gpt-4o-mini', baseUrlEnv: 'PROMA_AI_SDK_OPENAI_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS.openai },
  { provider: 'deepseek', apiKeyEnv: 'PROMA_AI_SDK_DEEPSEEK_API_KEY', fallbackApiKeyEnv: 'DEEPSEEK_API_KEY', modelEnv: 'PROMA_AI_SDK_DEEPSEEK_MODEL', model: 'deepseek-chat', baseUrlEnv: 'PROMA_AI_SDK_DEEPSEEK_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS.deepseek },
  { provider: 'kimi-api', apiKeyEnv: 'PROMA_AI_SDK_KIMI_API_KEY', fallbackApiKeyEnv: 'MOONSHOT_API_KEY', modelEnv: 'PROMA_AI_SDK_KIMI_API_MODEL', model: 'kimi-k2-0711-preview', baseUrlEnv: 'PROMA_AI_SDK_KIMI_API_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS['kimi-api'] },
  { provider: 'kimi-coding', apiKeyEnv: 'PROMA_AI_SDK_KIMI_CODING_API_KEY', modelEnv: 'PROMA_AI_SDK_KIMI_CODING_MODEL', model: 'kimi-for-coding', baseUrlEnv: 'PROMA_AI_SDK_KIMI_CODING_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS['kimi-coding'] },
  { provider: 'zhipu', apiKeyEnv: 'PROMA_AI_SDK_ZHIPU_API_KEY', modelEnv: 'PROMA_AI_SDK_ZHIPU_MODEL', model: 'glm-4-flash', baseUrlEnv: 'PROMA_AI_SDK_ZHIPU_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS.zhipu },
  { provider: 'doubao', apiKeyEnv: 'PROMA_AI_SDK_DOUBAO_API_KEY', modelEnv: 'PROMA_AI_SDK_DOUBAO_MODEL', model: 'doubao-seed-1-6-flash-250615', baseUrlEnv: 'PROMA_AI_SDK_DOUBAO_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS.doubao },
  { provider: 'qwen', apiKeyEnv: 'PROMA_AI_SDK_QWEN_API_KEY', fallbackApiKeyEnv: 'DASHSCOPE_API_KEY', modelEnv: 'PROMA_AI_SDK_QWEN_MODEL', model: 'qwen-turbo', baseUrlEnv: 'PROMA_AI_SDK_QWEN_BASE_URL', baseUrl: PROVIDER_DEFAULT_URLS.qwen },
]
const cases = matrix.map((entry) => ({ ...entry, apiKey: process.env[entry.apiKeyEnv] ?? (entry.fallbackApiKeyEnv ? process.env[entry.fallbackApiKeyEnv] : undefined), model: process.env[entry.modelEnv] ?? entry.model, baseUrl: process.env[entry.baseUrlEnv] ?? entry.baseUrl })).filter((entry): entry is RealCase & { apiKey: string } => Boolean(entry.apiKey))
const canRun = process.env.PROMA_WEB_REAL_E2E === '1' && Boolean(databaseUrl && redisUrl && cases.length)

test('服务端真实 Provider 矩阵覆盖所有 AI SDK 兼容 Provider', () => {
  expect(matrix.map((entry) => entry.provider).sort()).toEqual(getAgentCompatibleProviders('ai-sdk').filter((provider) => provider !== 'custom').sort())
})

describe.skipIf(!canRun)('服务端 AI SDK 真实 Provider E2E', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const client = { query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({ rows: await sql.unsafe<Row[]>(statement, [...params]) }) }
  const store = new PostgresTenantRuntimeStore(client)
  const usageLedger = new PostgresUsageLedger(client, [])
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
    expect((await usageLedger.list({ ...scope })).some((record) => record.taskId === task.taskId && record.provider === entry.provider)).toBe(true)
    // P-IV 真实数据挂钩：把本次真实 run 采样成评估数据集，断言样本归属于该 task。
    const datasetRes = await app.fetch(new Request('http://server/agent/datasets', { method: 'POST', headers, body: JSON.stringify({ name: `real-e2e-${entry.provider}`, windowMs: 3_600_000, sampleRate: 1 }) }))
    const { dataset } = await datasetRes.json() as { dataset: { datasetId: string; count: number } | { error: string } }
    expect((dataset as { datasetId?: string }).datasetId).toBeTruthy()
    const samplesRes = await app.fetch(new Request(`http://server/agent/datasets/${(dataset as { datasetId: string }).datasetId}/samples`, { headers }))
    const { samples } = await samplesRes.json() as { samples: Array<{ taskId: string }> }
    expect(samples.some((sample) => sample.taskId === task.taskId), '运行档案应能采样出本次 run').toBe(true)
  }, 90_000)
})
