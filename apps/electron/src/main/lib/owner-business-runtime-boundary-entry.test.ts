import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { AgentProviderAdapter, AgentQueryInput, SDKUserMessageInput } from '@gravitas/shared'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-business-runtime-entry-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
let claudeSdkCalls = 0
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: async function* () { claudeSdkCalls++; throw new Error('fixture禁止SDK启动') },
}))
const store = await import('./project-sqlite-store')
const { AISDKAgentAdapter } = await import('./adapters/ai-sdk-agent-adapter')
const { PiAgentAdapter } = await import('./adapters/pi-agent-adapter')
const { ClaudeAgentAdapter } = await import('./adapters/claude-agent-adapter')
beforeAll(() => store.initProjectDb())
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
function restrictedSession(): string {
  const project = store.createProject({ title: '合成已有runtime关联', description: '' })
  const task = store.createTask(project.id, { title: '范围fixture', description: '' })
  const sessionId = crypto.randomUUID()
  store.createAgentExecution({ id: crypto.randomUUID(), projectId: project.id, entityType: 'task', entityId: task.id, sessionId, agentId: 'synthetic-employee', executor: 'headless', prompt: '没有真实OwnerRun', status: 'running' })
  // indexed link残余，没有可信materialization，不因坏payload回退legacy。
  store.getProjectDb().prepare(`INSERT INTO project_owner_task_step_links
    (id,materialization_id,project_id,subject_key,plan_fingerprint,step_key,task_id,payload,integrity_hash)
    VALUES (?,?,?,'project',?,'a',?,'broken','broken')`).run(crypto.randomUUID(), 'missing-batch', project.id, 'a'.repeat(64), task.id)
  return sessionId
}
const queued: SDKUserMessageInput = { type: 'user', message: { role: 'user', content: '不能追加' }, parent_tool_use_id: null, uuid: 'fixture', session_id: 'fixture' }
const { ProviderAgnosticAgentAdapter } = await import('./adapters/provider-agnostic-agent-adapter')
for (const [name, build] of [
  ['proma', () => new ProviderAgnosticAgentAdapter()],
  ['ai-sdk', () => new AISDKAgentAdapter()],
  ['pi', () => new PiAgentAdapter()],
  ['claude', () => new ClaudeAgentAdapter()],
] as const) {
  test(`Given link-only Owner session When ${name} query Then 早于参数解析/SDK/Model拒绝`, async () => {
    const adapter = build()
    const sessionId = restrictedSession()
    // 故意不提供模型参数；必须先识别业务用途而不是走初始化或网络。
    const input: AgentQueryInput = { sessionId, prompt: '不可执行' }
    await expect(adapter.query(input)[Symbol.asyncIterator]().next()).rejects.toThrow('Owner')
    expect(claudeSdkCalls).toBe(0)
    adapter.dispose()
  })
  test(`Given link-only Owner session When ${name} queued/permission Then 早于活跃会话检查拒绝`, async () => {
    const adapter: AgentProviderAdapter = build()
    const sessionId = restrictedSession()
    await expect(adapter.sendQueuedMessage!(sessionId, queued)).rejects.toThrow('Owner')
    if (adapter.setPermissionMode) await expect(adapter.setPermissionMode(sessionId, 'safe')).rejects.toThrow('Owner')
    if (adapter.interruptQuery) await expect(adapter.interruptQuery(sessionId)).rejects.toThrow('Owner')
    // stop仍可执行，不赋予续跑权。
    expect(() => adapter.abort(sessionId)).not.toThrow()
    adapter.dispose()
  })
}
