import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { AgentProviderAdapter } from '@gravitas/shared'
import type { RuntimeServices } from './agent-runtime/runtime-services'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-business-runtime-orchestrator-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
// 这些是不可到达的外部副作用探针；用途判断与SQLite不mock。
mock.module('./token-usage-service', () => ({ tokenUsageService: { middleware: (_session: unknown, _event: unknown, next: () => void) => next(), start: () => {} } }))
const store = await import('./project-sqlite-store')
const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AgentEventBus } = await import('./agent-event-bus')
beforeAll(() => store.initProjectDb())
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const project = store.createProject({ title: 'Orchestrator合成旧账本', description: '' })
  const task = store.createTask(project.id, { title: '负向用途', description: '' })
  const sessionId = crypto.randomUUID()
  store.createAgentExecution({ id: crypto.randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, sessionId, agentId: 'synthetic', executor: 'headless', status: 'running', prompt: '无真实OwnerRun' })
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='broken' WHERE id=?").run(task.id)
  let queried = 0, credentials = 0, writes = 0
  const adapter: AgentProviderAdapter = { async *query() { queried++; }, abort: () => {}, dispose: () => {} }
  const services: RuntimeServices = {
    credentials: { resolveChannel: async () => { credentials++; return undefined } },
    workspaces: { resolveWorkspaceContext: () => ({ cwd: directory }) },
    sessions: { getHistoryMessages: () => [], appendMessages: () => { writes++ }, truncateMessages: () => [] },
    events: { emit: () => {} },
    mcp: { acquireClientManager: async () => { throw new Error('fixture禁止MCP') } },
  }
  const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus(), services)
  return { sessionId, orchestrator, counts: () => ({ queried, credentials, writes }) }
}
test('Given Owner业务 When sendMessage各Runtime Then 在队列/credentials/history之前拒绝', async () => {
  const { sessionId, orchestrator, counts } = fixture()
  const errors: string[] = []
  for (const agentRuntime of ['proma', 'ai-sdk', 'pi', 'claude'] as const) {
    await orchestrator.sendMessage({ sessionId, agentRuntime, userMessage: '禁止发送', channelId: 'fake', modelId: 'fake' }, { onError: error => errors.push(error), onComplete: () => {}, onTitleUpdated: () => {} })
  }
  expect(errors).toHaveLength(4)
  expect(errors.every(error => error.includes('Owner'))).toBe(true)
  expect(counts()).toEqual({ queried: 0, credentials: 0, writes: 0 })
})
test('Given Owner业务 When permission/steering直达 Then 不能因未active静默返回或排队', async () => {
  const { sessionId, orchestrator, counts } = fixture()
  await expect(orchestrator.updateSessionPermissionMode(sessionId, 'safe')).rejects.toThrow('Owner')
  await expect(orchestrator.queueMessage(sessionId, '不能追加')).rejects.toThrow('Owner')
  expect(counts()).toEqual({ queried: 0, credentials: 0, writes: 0 })
})
test('Given Owner业务 When session-scoped标题请求 Then 早于credential/model拒绝', async () => {
  const { sessionId, orchestrator, counts } = fixture()
  // optional session identity是内部自动标题调用携带的，不是新的客户端授权DTO。
  const title = await orchestrator.generateTitle({ userMessage: '不能用于标题请求', channelId: 'fake', modelId: 'fake' }, sessionId)
  expect(title).toBeNull()
  expect(counts()).toEqual({ queried: 0, credentials: 0, writes: 0 })
})

test('Given Owner业务 When direct内部subagent入口 Then 不创建子会话或调用child Model', async () => {
  const { sessionId, orchestrator, counts } = fixture()
  await expect(orchestrator['runProviderAgnosticSubAgent'](sessionId,
    { provider: 'openai', apiKey: 'fixture', baseUrl: 'https://example.invalid', cwd: directory, permissionMode: 'safe' },
    { agentName: 'researcher', task: '不能委派' },
  )).rejects.toThrow('Owner')
  expect(counts()).toEqual({ queried: 0, credentials: 0, writes: 0 })
})
