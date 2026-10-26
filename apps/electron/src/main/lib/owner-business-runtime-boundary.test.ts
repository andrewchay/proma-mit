import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-business-runtime-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const boundary = await import('./controlled-provider-boundary')
const registry = await import('./agent-headless-runner-registry')
beforeAll(() => store.initProjectDb())
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const project = store.createProject({ title: '仅合成既有账本', description: '' })
  const task = store.createTask(project.id, { title: '尚未受限的历史任务', description: '' })
  const legacyTask = store.createTask(project.id, { title: '同项目普通任务', description: '' })
  const sessionId = crypto.randomUUID()
  for (const candidate of [legacyTask, task]) {
    store.createAgentExecution({ id: crypto.randomUUID(), projectId: project.id, entityType: 'task', entityId: candidate.id, agentId: 'synthetic-employee', sessionId, executor: 'headless', prompt: '没有真实OwnerRun', status: 'running' })
  }
  const restrict = () => store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(task.id)
  return { project, task, legacyTask, sessionId, restrict }
}
const actual = () => ({ runtime: 'pi' as const, cwd: directory, modelId: 'fixture', permissionMode: 'safe' })

test('Given 初始legacy fetch When 后来出现空marker用途 Then 在request/admission/send之前拒绝', async () => {
  const { sessionId, restrict } = fixture()
  let requests = 0
  const transport = Object.assign(async () => { requests++; return new Response('{}') }, { preconnect: () => {} }) as typeof fetch
  const fetchFn = boundary.createControlledProviderFetch(sessionId, actual, transport)
  expect(fetchFn).toBeDefined()
  await fetchFn!('https://example.invalid', { body: '{}' })
  expect(requests).toBe(1)
  restrict()
  await expect(fetchFn!('https://example.invalid', { body: '{}' })).rejects.toThrow('Owner')
  expect(requests).toBe(1)
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM controlled_task_preparations WHERE provider_admitted_at IS NOT NULL').get()).toEqual({ c: 0 })
})

test('Given Owner用途 When Runner或权限或工具桥直达 Then 不交接Runner且不改变权限', async () => {
  const { sessionId, restrict } = fixture()
  let runners = 0, handoffs = 0
  registry.setHeadlessAgentRunner(async () => { runners++ })
  restrict()
  await expect(registry.runRegisteredHeadlessAgent({ sessionId, userMessage: '不要执行', channelId: 'fake', modelId: 'fake' }, { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {}, onRunnerInvoke: () => { handoffs++ } })).rejects.toThrow('Owner')
  expect(runners).toBe(0)
  expect(handoffs).toBe(0)
  expect(() => boundary.assertControlledPermissionChange(sessionId, 'safe')).toThrow('Owner')
  expect(() => boundary.guardControlledPiToolContext(sessionId, { cwd: directory, sessionId })).toThrow('Owner')
})

test('Given Runner交接回调期间用途变化 When 调用真实Runner前 Then 再读且零Runner', async () => {
  const { sessionId, restrict } = fixture()
  let runners = 0
  registry.setHeadlessAgentRunner(async () => { runners++ })
  await expect(registry.runRegisteredHeadlessAgent({ sessionId, userMessage: 'fixture', channelId: 'fake', modelId: 'fake' }, { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {}, onRunnerInvoke: restrict })).rejects.toThrow('Owner')
  expect(runners).toBe(0)
})

for (const method of ['stream', 'streamSimple'] as const) {
  test(`Given 初始legacy Pi ${method} When 异步payload钩子新增用途 Then 钩子后拒绝且零send`, async () => {
    const { sessionId, restrict } = fixture()
    let sent = 0
    const model = { id: 'fixture', baseUrl: 'https://example.invalid' }
    const stream = async (_model: unknown, _context: unknown, options: { onPayload?: (payload: unknown, requestModel: { id: string; baseUrl: string }) => Promise<unknown> }) => {
      await options.onPayload?.({}, model)
      sent++
    }
    const runtime = { stream, streamSimple: stream, streamDeferred: () => { sent++ }, fetchDeferred: () => { sent++ }, generateImages: () => { sent++ }, classify: () => { sent++ } } as unknown as ModelRuntime
    boundary.guardControlledPiModelRuntime(sessionId, runtime, actual)
    const invoke = runtime[method] as unknown as typeof stream
    await expect(invoke(model, {}, { onPayload: async () => { await Promise.resolve(); restrict(); return {} } })).rejects.toThrow('Owner')
    expect(sent).toBe(0)
  })
}

test('Given 初始legacy Pi runtime When 用途后来变化 Then deferred/images/classify均前置拒绝', () => {
  const { sessionId, restrict } = fixture()
  let calls = 0
  const invoke = () => { calls++ }
  const runtime = { stream: invoke, streamSimple: invoke, streamDeferred: invoke, fetchDeferred: invoke, generateImages: invoke, classify: invoke } as unknown as ModelRuntime
  boundary.guardControlledPiModelRuntime(sessionId, runtime, actual)
  restrict()
  for (const method of ['streamDeferred', 'fetchDeferred', 'generateImages', 'classify'] as const) {
    expect(() => (runtime[method] as unknown as () => void)()).toThrow('Owner')
  }
  expect(calls).toBe(0)
})

for (const method of ['stream', 'streamSimple'] as const) {
  test(`Given 真实Pi ModelRuntime ${method}且初始化legacy When async payload后新增用途 Then 零HTTP/费用准入`, async () => {
    const { sessionId, restrict } = fixture()
    const { registerPiModelFromChannel } = await import('./adapters/pi-model-registry')
    const registration = await registerPiModelFromChannel({ sessionId, provider: 'openai', apiKey: 'fixture', baseUrl: 'https://example.invalid', modelId: 'fixture' })
    let sends = 0
    const fetch = Object.assign(async () => { sends++; throw new Error('fixture不允许网络') }, { preconnect: () => {} }) as typeof globalThis.fetch
    boundary.guardControlledPiModelRuntime(sessionId, registration.modelRuntime, actual, fetch)
    const result = await registration.modelRuntime[method](registration.model,
      { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] },
      { apiKey: 'fixture', maxRetries: 0, onPayload: async () => { await Promise.resolve(); restrict() } },
    ).result()
    expect(sends).toBe(0)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('Owner')
    for (const table of ['pilot_request_reservations', 'project_owner_planning_admissions']) {
      expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).toEqual({ c: 0 })
    }
  })
}

test('Given captured final fetch已观察Owner When execution关系部分丢失 Then residual用途仍拒发', async () => {
  const { sessionId, restrict } = fixture()
  let sends = 0
  const fetch = Object.assign(async () => { sends++; return new Response('{}') }, { preconnect: () => {} }) as typeof globalThis.fetch
  const captured = boundary.createControlledProviderFetch(sessionId, actual, fetch)
  restrict()
  await expect(captured('https://example.invalid', { body: '{}' })).rejects.toThrow('Owner')
  store.getProjectDb().prepare("UPDATE agent_executions SET session_id='lost-reference' WHERE session_id=?").run(sessionId)
  await expect(captured('https://example.invalid', { body: '{}' })).rejects.toThrow('Owner')
  expect(sends).toBe(0)
})

test('Given 同项目另一个Owner task When 无关legacy session请求 Then 不whole-project误封', async () => {
  const { project, legacyTask, restrict } = fixture()
  restrict()
  const sessionId = crypto.randomUUID()
  store.createAgentExecution({ id: crypto.randomUUID(), projectId: project.id, entityType: 'task', entityId: legacyTask.id, sessionId, agentId: 'synthetic', executor: 'headless', prompt: '普通旧用途不授予新许可', status: 'running' })
  let sends = 0
  const fetch = Object.assign(async () => { sends++; return new Response('{}') }, { preconnect: () => {} }) as typeof globalThis.fetch
  await boundary.createControlledProviderFetch(sessionId, actual, fetch)('https://example.invalid', { body: '{}' })
  expect(sends).toBe(1)
})

for (const method of ['streamDeferred', 'fetchDeferred', 'generateImages', 'classify'] as const) {
  test(`Given legacy ${method} When async payload用途变化 Then alternate final hook也拒绝`, async () => {
    const { sessionId, restrict } = fixture()
    let sends = 0
    const invoke = async (_model: unknown, _context: unknown, options: { onPayload?: (payload: unknown, model: unknown) => Promise<unknown> }) => {
      await options.onPayload?.({}, { id: 'fixture' })
      sends++
    }
    const runtime = { stream: invoke, streamSimple: invoke, streamDeferred: invoke, fetchDeferred: invoke, generateImages: invoke, classify: invoke } as unknown as ModelRuntime
    boundary.guardControlledPiModelRuntime(sessionId, runtime, actual)
    await expect((runtime[method] as unknown as typeof invoke)({}, {}, { onPayload: async () => { await Promise.resolve(); restrict() } })).rejects.toThrow('Owner')
    expect(sends).toBe(0)
  })
}
