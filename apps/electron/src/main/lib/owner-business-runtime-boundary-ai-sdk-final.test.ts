import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-business-ai-sdk-final-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
let sends = 0, modelInvocations = 0
let beforeModelSend: (() => void) | undefined
const transport = Object.assign(async () => {
  sends++
  return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"离线结果"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}, { preconnect: () => {} }) as typeof fetch
mock.module('./proxy-fetch', () => ({ getFetchFn: () => transport }))
const realBridge = await import('@gravitas/core/providers/ai-sdk-bridge')
const createRealModel = realBridge.createAgentAISDKModel
mock.module('@gravitas/core/providers/ai-sdk-bridge', () => ({
  ...realBridge,
  // 保留真实AI SDK model/core/HTTP构造，仅在doStream前插入异步用途变更探针。
  createAgentAISDKModel: (input: Parameters<typeof createRealModel>[0]) => {
    const model = createRealModel(input)
    if (typeof model !== 'object') throw new Error('fixture需要真实模型对象')
    return new Proxy(model, {
      get(target, property) {
        if (property !== 'doStream') return Reflect.get(target, property, target)
        return async (...args: unknown[]) => {
          modelInvocations++
          await Promise.resolve()
          beforeModelSend?.()
          return Reflect.apply(Reflect.get(target, property) as (...input: unknown[]) => Promise<unknown>, target, args)
        }
      },
    })
  },
}))
const { AISDKAgentAdapter } = await import('./adapters/ai-sdk-agent-adapter')
beforeAll(() => store.initProjectDb())
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const project = store.createProject({ title: '真实SDK离线transport', description: '' })
  const task = store.createTask(project.id, { title: '模拟已有legacy账本', description: '' })
  const sessionId = crypto.randomUUID()
  store.createAgentExecution({ id: crypto.randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, sessionId, agentId: 'synthetic', executor: 'headless', status: 'running', prompt: '无真实OwnerRun' })
  return { task, sessionId, restrict: () => store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(task.id) }
}
async function run(sessionId: string): Promise<void> {
  const adapter = new AISDKAgentAdapter()
  try {
    for await (const _message of adapter.query({ sessionId, prompt: '仅离线fixture', provider: 'openai', apiKey: 'fixture', baseUrl: 'https://example.invalid', model: 'fixture', cwd: directory, maxRetries: 0, maxTurns: 1 })) { /* 消费真实SDK事件。 */ }
  } finally { adapter.dispose() }
}
test('Given 普通legacy真实AI SDK When 最终fetch已注入负向guard Then 保留普通离线HTTP行为', async () => {
  const { sessionId } = fixture()
  beforeModelSend = undefined
  const before = sends
  await run(sessionId)
  expect(sends).toBe(before + 1)
})
test('Given legacy初始化的真实AI SDK When 异步模型钩子后出现Owner用途 Then final fetch拒绝且零request/admission/HTTP', async () => {
  const { sessionId, restrict } = fixture()
  const before = sends, invoked = modelInvocations
  beforeModelSend = restrict
  // AI SDK可能将底层拒绝收敛为NoOutputGenerated；持久负向用途与零HTTP共同断言。
  try { await expect(run(sessionId)).rejects.toThrow() }
  finally { beforeModelSend = undefined }
  expect(modelInvocations).toBeGreaterThan(invoked)
  expect(sends).toBe(before)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_business_session_restrictions WHERE session_id=?').get(sessionId)).toEqual({ c: 1 })
  for (const table of ['pilot_request_reservations', 'project_owner_planning_admissions']) {
    expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({ c: 0 })
  }
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM controlled_task_preparations WHERE provider_admitted_at IS NOT NULL').get()).toEqual({ c: 0 })
})
