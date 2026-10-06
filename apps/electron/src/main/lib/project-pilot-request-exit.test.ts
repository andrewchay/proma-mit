import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createAgentExecution, createProject, createTask, getProjectDb, initProjectDb }
  from './project-sqlite-store'
import { claimPilotCommandStart, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { calculatePilotRequestCeiling } from './project-pilot-request-envelope'
import { derivePilotRequestEnvelope } from './project-pilot-request-evidence'
import { buildPilotRequestRuntime, createPilotRequestFetch, resolvePilotBudgetForSession }
  from './project-pilot-request-exit'

const dir = mkdtempSync(join(tmpdir(), 'pilot-request-exit-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const project = createProject({ title: '受控出口', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const grantId = `grant-${project.id}`
  const sessionId = `session-${project.id}`
  insertPilotGrantFixture({ grantId, projectId: project.id, state: 'active', workspaceId: 'workspace-a',
    channelId: 'channel-a', modelId: 'glm-5.3-flash', maxCostMicros: 1000, maxRuns: 2,
    maxRework: 0, expiresAt: Date.now() + 100000, createdAt: Date.now() })
  const commandId = `cmd-${project.id}`
  const executionId = `exec-${project.id}`
  reserveAndQueuePilotCommand({ commandId, projectId: project.id, grantId, idempotencyKey: 'run',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor', reworkOrdinal: 0 }, { executionId, prompt: '执行' })
  claimPilotCommandStart(executionId, commandId, 1, sessionId)
  return { project, commandId, executionId, sessionId }
}

const GLM_BODY = '{"model":"glm-5.3-flash","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'
const GLM_MULTIMODAL = '{"model":"glm-5.3-flash","max_tokens":100,"messages":[{"role":"user","content":['
  + '{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"https://example.com/a.png"}}]}]}'
const GLM_NO_LIMIT = '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}'

function fakeFetchRecording(hits: string[], response?: Response): typeof globalThis.fetch {
  const fake = async (_input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    hits.push(typeof init?.body === 'string' ? init.body : '')
    if (response) return response
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return Object.assign(fake, { preconnect: () => {} })
}

function sseResponse(events: string[], status = 200): Response {
  return new Response(events.join(''), { status, headers: { 'content-type': 'text/event-stream' } })
}

async function waitForState(executionId: string, state: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = getProjectDb().prepare('SELECT state FROM pilot_request_reservations WHERE execution_id = ?')
      .get(executionId) as { state: string } | undefined
    if (row?.state === state) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待执行 ${executionId} 的请求进入 ${state} 超时`)
}

test('Given 预算内合法请求 When 经过受控出口 Then 恰好一次 HTTP 且按实际用量结算', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const pilotFetch = createPilotRequestFetch({ commandId, executionId, sessionId,
    baseFetch: fakeFetchRecording(hits) })
  const response = await pilotFetch('https://api.example/v1/chat/completions',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: GLM_BODY })
  expect(response.status).toBe(200)
  expect(hits).toEqual([GLM_BODY])
  await waitForState(executionId, 'settled')
  // usage 10/10 按 GLM 证据价（150000/500000 每百万）结算：ceil((10×0.15 + 10×0.5)) = 7 micro-USD。
  expect(getProjectDb().prepare('SELECT settled_cost_micros FROM pilot_request_reservations WHERE execution_id = ?')
    .get(executionId) as { settled_cost_micros: number }).toEqual({ settled_cost_micros: 7 })
})

test('Given 预算不足或多模态或缺输出上限 When 请求 Then HTTP 零发送', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const pilotFetch = createPilotRequestFetch({ commandId, executionId, sessionId,
    baseFetch: fakeFetchRecording(hits) })
  const huge = '{"model":"glm-5.3-flash","max_tokens":100000,"messages":[{"role":"user","content":"hi"}]}'
  await expect(pilotFetch('https://api.example', { method: 'POST', body: huge })).rejects.toThrow('超过可用额度')
  await expect(pilotFetch('https://api.example', { method: 'POST', body: GLM_MULTIMODAL })).rejects.toThrow('多模态内容')
  await expect(pilotFetch('https://api.example', { method: 'POST', body: GLM_NO_LIMIT })).rejects.toThrow('缺少强制输出上限')
  await expect(pilotFetch('https://api.example', { method: 'POST', body: new Uint8Array(8) })).rejects.toThrow('无法核验请求体')
  expect(hits).toEqual([])
})

test('Given 同一请求体再次到达 When 换 requestId 也拒绝 Then 不重复发送', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const first = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: fakeFetchRecording(hits) })
  await first('https://api.example', { method: 'POST', body: GLM_BODY })
  await waitForState(executionId, 'settled')
  // 崩溃重开库后新出口闭包发同一 body：指纹唯一约束对已结算行同样生效。
  closeProjectDb()
  await initProjectDb()
  const second = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: fakeFetchRecording(hits) })
  await expect(second('https://api.example', { method: 'POST', body: GLM_BODY })).rejects.toThrow('指纹已预留')
  expect(hits).toEqual([GLM_BODY])
  expect(getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_request_reservations WHERE execution_id = ?')
    .get(executionId)).toEqual({ n: 1 })
})

test('Given 流式响应携带 usage 块 When 经过受控出口 Then 注入 include_usage 并按流式用量结算', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const streamBody = '{"model":"glm-5.3-flash","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
  const pilotFetch = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: fakeFetchRecording(hits,
    sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":20}}\n\n',
      'data: [DONE]\n\n',
    ])) })
  const response = await pilotFetch('https://api.example', { method: 'POST', body: streamBody })
  expect(response.status).toBe(200)
  // 注入后的最终 body 才是指纹与发送对象：include_usage 必须已在请求中。
  const sent = JSON.parse(hits[0] ?? '{}') as { stream_options?: { include_usage?: boolean } }
  expect(sent.stream_options?.include_usage).toBe(true)
  await waitForState(executionId, 'settled')
  // usage 30/20：ceil((30×150000 + 20×500000)/1e6) = 15 micro-USD。
  expect(getProjectDb().prepare('SELECT settled_cost_micros FROM pilot_request_reservations WHERE execution_id = ?')
    .get(executionId) as { settled_cost_micros: number }).toEqual({ settled_cost_micros: 15 })
})

test('Given 流式响应缺失用量 When 响应结束 Then 转入待对账且占额不释放', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const streamBody = '{"model":"glm-5.3-flash","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"hi"}]}'
  const pilotFetch = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: fakeFetchRecording(hits,
    sseResponse(['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', 'data: [DONE]\n\n'])) })
  await pilotFetch('https://api.example', { method: 'POST', body: streamBody })
  await waitForState(executionId, 'needs_reconcile')
  expect(getProjectDb().prepare(`SELECT reserved_cost_micros AS reserved, settled_cost_micros AS settled
    FROM pilot_request_reservations WHERE execution_id = ?`).get(executionId) as { reserved: number; settled: number | null })
    .toEqual({ reserved: expect.any(Number), settled: null })
})

test('Given 非 2xx 响应 When 费用无法证明未计费 Then 转入待对账', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const pilotFetch = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: fakeFetchRecording(hits,
    new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } })) })
  const response = await pilotFetch('https://api.example', { method: 'POST', body: GLM_BODY })
  expect(response.status).toBe(500)
  await waitForState(executionId, 'needs_reconcile')
})

test('Given 崩溃导致响应永不到达 When 请求中断 Then 保持 reserved 占额且重复发送被拒', async () => {
  const { commandId, executionId, sessionId } = fixture()
  let crashReject: (error: unknown) => void = () => {}
  const crashingBase = Object.assign(async () => {
    await new Promise((_, reject) => { crashReject = reject })
    throw new Error('connection lost')
  }, { preconnect: () => {} }) as typeof globalThis.fetch
  const pilotFetch = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: crashingBase })
  const pending = pilotFetch('https://api.example', { method: 'POST', body: GLM_BODY }).catch(() => 'crashed')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const expectedReserve = calculatePilotRequestCeiling(
    derivePilotRequestEnvelope({ body: GLM_BODY, priceEvidenceId: 'zai-glm-5.3-flash-2026-09-28' }), 500)
  expect(getProjectDb().prepare('SELECT state, reserved_cost_micros AS reserved FROM pilot_request_reservations WHERE execution_id = ?')
    .get(executionId) as { state: string; reserved: number }).toEqual({ state: 'reserved', reserved: expectedReserve })
  crashReject(new Error('connection lost'))
  await pending
  // 崩溃后换出口重发同一 body：指纹唯一约束兜底。
  const second = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: fakeFetchRecording([]) })
  await expect(second('https://api.example', { method: 'POST', body: GLM_BODY })).rejects.toThrow('指纹已预留')
})

test('Given Pilot 受控执行 When 按 sessionId 反查 Then 返回预算上下文；普通执行返回空', () => {
  const { project, commandId, executionId, sessionId } = fixture()
  expect(resolvePilotBudgetForSession(sessionId)).toEqual({ commandId, executionId, sessionId })
  const task = createTask(project.id, { title: '普通任务', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  createAgentExecution({ id: `plain-exec-${project.id}`, projectId: project.id, entityType: 'task', entityId: task.id,
    agentId: 'executor', sessionId: `plain-${project.id}`, prompt: '普通执行', status: 'running' })
  expect(resolvePilotBudgetForSession(`plain-${project.id}`)).toBeUndefined()
  expect(resolvePilotBudgetForSession('missing-session')).toBeUndefined()
})

test('Given 构建 Pilot 运行时 When 使用默认证据 Then 输出上限来自审核记录且出口可用', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const runtime = buildPilotRequestRuntime({ commandId, executionId, sessionId }, fakeFetchRecording(hits))
  expect(runtime.maxOutputTokens).toBe(131_072)
  const response = await runtime.fetch('https://api.example', { method: 'POST', body: GLM_BODY })
  expect(response.status).toBe(200)
  expect(hits).toEqual([GLM_BODY])
})
