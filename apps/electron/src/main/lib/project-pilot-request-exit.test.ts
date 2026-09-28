import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createAgentExecution, createProject, createTask, getProjectDb, initProjectDb }
  from './project-sqlite-store'
import { claimPilotCommandStart, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
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

function fakeFetchRecording(hits: string[], status = 200): typeof globalThis.fetch {
  const fake = async (_input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    hits.push(typeof init?.body === 'string' ? init.body : '')
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status, headers: { 'content-type': 'application/json' } })
  }
  return Object.assign(fake, { preconnect: () => {} })
}

test('Given 预算内合法请求 When 经过受控出口 Then 恰好一次 HTTP 且预留与指纹核验通过', async () => {
  const { commandId, executionId, sessionId } = fixture()
  const hits: string[] = []
  const pilotFetch = createPilotRequestFetch({ commandId, executionId, sessionId,
    baseFetch: fakeFetchRecording(hits) })
  const response = await pilotFetch('https://api.example/v1/chat/completions',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: GLM_BODY })
  expect(response.status).toBe(200)
  expect(hits).toEqual([GLM_BODY])
  const rows = getProjectDb().prepare('SELECT COUNT(*) AS n, SUM(reserved_cost_micros) AS total FROM pilot_request_reservations')
    .get() as { n: number; total: number }
  expect(rows.n).toBe(1)
  expect(rows.total).toBeGreaterThan(0)
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
  // 崩溃重开库后新出口闭包（requestId 序列不同）发同一 body：指纹唯一约束兜底。
  closeProjectDb()
  await initProjectDb()
  const second = createPilotRequestFetch({ commandId, executionId, sessionId, baseFetch: fakeFetchRecording(hits) })
  await expect(second('https://api.example', { method: 'POST', body: GLM_BODY })).rejects.toThrow('指纹已预留')
  expect(hits).toEqual([GLM_BODY])
  expect(getProjectDb().prepare('SELECT COUNT(*) AS n FROM pilot_request_reservations WHERE execution_id = ?')
    .get(executionId)).toEqual({ n: 1 })
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
