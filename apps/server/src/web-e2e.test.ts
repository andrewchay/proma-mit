import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  InMemoryAgentRuntimeObjectStore,
  PostgresTenantRuntimeStore,
} from '@proma/shared/utils'
import type { AgentRuntimeWebAgentTurnRunner } from '@proma/shared/utils'
import { createPromaWebServerApplication } from './app.ts'

const databaseUrl = process.env.PROMA_P2_TEST_DATABASE_URL
const redisUrl = process.env.PROMA_P2_TEST_REDIS_URL
const canRun = Boolean(databaseUrl && redisUrl)

describe.skipIf(!canRun)('Web 多实例本地 E2E', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const client = {
    query: async <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => ({
      rows: await sql.unsafe<Row[]>(statement, [...params]),
    }),
  }
  const store = new PostgresTenantRuntimeStore(client)
  const objectStore = new InMemoryAgentRuntimeObjectStore()
  const scope = { tenantId: `e2e-${crypto.randomUUID()}`, userId: 'user-a' }
  const config = {
    databaseUrl: databaseUrl!,
    redisUrl: redisUrl!,
    s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 },
    envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg',
    envelopeKeyId: 'test-v1',
    trustedHeaderAuth: true,
    workspaceRoot: '/private/tmp/proma-web-e2e',
    taskLeaseMs: 30_000,
  }
  const runner: AgentRuntimeWebAgentTurnRunner = async (input) => {
    input.emit({ kind: 'agent_event', event: { type: 'text_delta', text: 'fixture' } })
    input.emit({ kind: 'agent_event', event: { type: 'complete', stopReason: 'end_turn' } })
    return [{
      type: 'assistant' as const,
      message: { content: [{ type: 'text' as const, text: 'fixture response' }] },
      parent_tool_use_id: null,
      session_id: input.session.sessionId,
    }]
  }
  const alpha = createPromaWebServerApplication({ ...config, workerId: 'worker-alpha' }, { objectStore, agentTurnRunner: runner })
  const beta = createPromaWebServerApplication({ ...config, workerId: 'worker-beta' }, { objectStore, agentTurnRunner: runner })
  const headers = { 'content-type': 'application/json', 'x-proma-tenant-id': scope.tenantId, 'x-proma-user-id': scope.userId }

  beforeAll(async () => {
    await alpha.initialize()
    await beta.initialize()
    await store.setCredential({ ...scope, channelId: 'channel-a', provider: 'openai', apiKey: 'test', baseUrl: 'https://example.invalid', defaultModel: 'test-model' })
    await store.setWorkspace({ ...scope, workspaceSlug: 'workspace-a', cwd: '/ignored', mcpServers: {} })
  })

  afterAll(async () => {
    await alpha.shutdown()
    await beta.shutdown()
    await sql.unsafe('DELETE FROM proma_runtime_schedule_runs WHERE tenant_id = $1 AND user_id = $2', [scope.tenantId, scope.userId])
    await sql.unsafe('DELETE FROM proma_runtime_schedules WHERE tenant_id = $1 AND user_id = $2', [scope.tenantId, scope.userId])
    await sql.close()
  })

  test('跨实例创建、运行、重放事件并隔离 workspace 文件', async () => {
    const created = await alpha.fetch(new Request('http://alpha/agent/sessions', {
      method: 'POST', headers, body: JSON.stringify({ sessionId: 'session-a', workspaceSlug: 'workspace-a', channelId: 'channel-a' }),
    }))
    expect(created.status).toBe(201)

    const upload = await beta.fetch(new Request('http://beta/agent/workspaces/workspace-a/files/notes%2Fhello.txt', {
      method: 'PUT', headers, body: 'hello',
    }))
    expect(upload.status).toBe(201)
    const download = await alpha.fetch(new Request('http://alpha/agent/workspaces/workspace-a/files/notes%2Fhello.txt', { headers }))
    expect(await download.text()).toBe('hello')

    const started = await alpha.fetch(new Request('http://alpha/agent/sessions/session-a/run', {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }),
    }))
    const task = await started.json() as { task: { taskId: string } }
    await waitForTask(task.task.taskId)

    const events = await beta.fetch(new Request('http://beta/agent/sessions/session-a/events', { headers }))
    const replay = await readSSEReplay(events)
    expect(replay).toContain('fixture')
    expect(replay).toContain('sdk_message')
  })

  test('定时任务管理 API 按租户会话创建，并可跨实例暂停与恢复', async () => {
    const created = await alpha.fetch(new Request('http://alpha/agent/sessions', {
      method: 'POST', headers, body: JSON.stringify({ sessionId: 'schedule-session', workspaceSlug: 'workspace-a', channelId: 'channel-a' }),
    }))
    expect(created.status).toBe(201)

    const scheduleResponse = await alpha.fetch(new Request('http://alpha/agent/schedules', {
      method: 'POST', headers, body: JSON.stringify({ sessionId: 'schedule-session', prompt: '检查状态', intervalMs: 60_000 }),
    }))
    expect(scheduleResponse.status).toBe(201)
    const { schedule } = await scheduleResponse.json() as { schedule: { scheduleId: string; enabled: boolean } }
    expect(schedule.enabled).toBe(true)

    const paused = await beta.fetch(new Request(`http://beta/agent/schedules/${schedule.scheduleId}/pause`, { method: 'POST', headers }))
    expect((await paused.json() as { schedule: { enabled: boolean } }).schedule.enabled).toBe(false)
    const resumed = await alpha.fetch(new Request(`http://alpha/agent/schedules/${schedule.scheduleId}/resume`, { method: 'POST', headers }))
    expect((await resumed.json() as { schedule: { enabled: boolean } }).schedule.enabled).toBe(true)

    const cronResponse = await beta.fetch(new Request('http://beta/agent/schedules', {
      method: 'POST', headers, body: JSON.stringify({ sessionId: 'schedule-session', prompt: 'Cron 检查', schedule: { type: 'cron', expression: '*/5 * * * * *', timezone: 'Asia/Shanghai' } }),
    }))
    expect(cronResponse.status).toBe(201)
    expect((await cronResponse.json() as { schedule: { schedule: unknown } }).schedule.schedule).toEqual({ type: 'cron', expression: '*/5 * * * * *', timezone: 'Asia/Shanghai' })
  })

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
