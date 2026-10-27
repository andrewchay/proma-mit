import { expect, mock, test } from 'bun:test'
import type { AgentProviderAdapter, AgentSendInput } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
mock.module('electron', () => buildElectronMock())
const projectStore = await import('./project-sqlite-store')
mock.module('./project-sqlite-store', () => ({ ...projectStore,
  getAgentExecutionBySessionId: () => ({ id: 'execution', agentId: 'employee', ownerCommandId: 'command' }),
  getAgentEmployee: () => ({ runtime: 'pi', enabled: true }),
}))
// 此处只隔离已由启动链BDD覆盖的冻结身份核验，保留真实sendMessage的Runtime入口。
let handoffs = 0
const start = await import('./project-owner-execution-start')
mock.module('./project-owner-execution-start', () => ({ ...start, assertOwnerCommandRuntimeContext: () => { handoffs++ } }))
const planning = await import('./project-owner-planning-source')
mock.module('./project-owner-planning-source', () => ({ ...planning, resolveOwnerPlanningSession: () => { throw new Error('已通过Owner业务Runtime入口') } }))
const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AgentEventBus } = await import('./agent-event-bus')
test('Given 已确认Pi员工的dispatcher输入 When 经过真实sendMessage Then允许匹配的Pi但拒绝换Runtime或附加MCP', async () => {
  let queries = 0
  const adapter: AgentProviderAdapter = { async *query() { queries++ }, abort() {}, dispose() {} }
  const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus())
  const errors: string[] = []
  const input: AgentSendInput = { sessionId: 'session', channelId: 'channel', userMessage: '执行任务', agentRuntime: 'pi' }
  const callbacks = { ownerExecution: { executionId: 'execution', commandId: 'command' }, onError: (message: string) => { errors.push(message) }, onComplete() {}, onTitleUpdated() {} }
  await orchestrator.sendMessage(input, callbacks)
  await orchestrator.sendMessage({ ...input, agentRuntime: 'ai-sdk' }, callbacks)
  await orchestrator.sendMessage({ ...input, customMcpServers: {} }, callbacks)
  expect(errors).toEqual(['已通过Owner业务Runtime入口', 'Owner业务Runtime与已确认员工不匹配', 'Owner业务Runtime不允许MCP、Skills、Workflow、附件或委派上下文'])
  expect(handoffs).toBe(3)
  expect(queries).toBe(0)
})
