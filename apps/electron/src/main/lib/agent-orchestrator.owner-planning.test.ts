import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter, AgentQueryInput, AgentSendInput, SDKMessage } from '@gravitas/shared'
import type { SessionCallbacks } from './agent-orchestrator'
import { buildElectronMock } from './testing/electron-mock'
const dir = mkdtempSync(join(tmpdir(), 'owner-orchestrator-'))
process.env.PROMA_TEST_CONFIG_DIR = dir
afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })
mock.module('electron', () => buildElectronMock())
let broken = false, dynamic = 0, workspaceContext = 0, history = 0
const source = { binding: { channelId: 'channel', modelId: 'model', workspaceId: 'ws', runtime: 'ai-sdk' }, request: { systemPrompt: 'authority-system', userPrompt: 'authority-user' } }
mock.module('./project-owner-planning-source', () => ({ resolveOwnerPlanningSession: () => { if (broken) throw new Error('Owner evidence corrupt'); return source } }))
const channelModule = await import('./channel-manager')
mock.module('./channel-manager', () => ({ ...channelModule, getChannelById: () => ({ provider: 'openai', baseUrl: 'https://offline.invalid/v1' }), decryptApiKey: () => 'fake' }))
const workspaceModule = await import('./agent-workspace-manager')
mock.module('./agent-workspace-manager', () => ({ ...workspaceModule, getAgentWorkspace: () => ({}), getAgentWorkspaceCwd: () => dir }))
const promptModule = await import('./agent-prompt-builder')
mock.module('./agent-prompt-builder', () => ({ ...promptModule, buildDynamicContext: () => { dynamic++; throw new Error('dynamic forbidden') } }))
const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AgentEventBus } = await import('./agent-event-bus')
const input: AgentSendInput = { sessionId: 'owner', channelId: 'channel', modelId: 'model', workspaceId: 'ws', agentRuntime: 'ai-sdk', userMessage: '/skill:evil', runtimeInstruction: 'evil', mentionedSkills: ['evil'], mentionedMcpServers: ['evil'], mentionedSessionIds: ['evil'], attachments: [{ localPath: '/should/not/read' } as never] }
function harness() {
  const queries: AgentQueryInput[] = [], persisted: SDKMessage[] = [], errors: string[] = [], completions: unknown[] = []
  const adapter: AgentProviderAdapter = { async *query(q) { queries.push(q); yield { type: 'assistant', message: { content: [{ type: 'text', text: 'raw-answer' }] } } as SDKMessage; yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } } as SDKMessage }, abort() {}, dispose() {} }
  const services = { workspaces: { resolveWorkspaceContext: () => { workspaceContext++; throw new Error('MCP workspace forbidden') } }, sessions: { getHistoryMessages: () => { history++; throw new Error('history forbidden') }, appendMessages: (_id: string, messages: SDKMessage[]) => { persisted.push(...messages) } }, events: { emit() {} } } as unknown as ConstructorParameters<typeof AgentOrchestrator>[2]
  const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus(), services)
  // 第一条 assistant 不能调用标题模型；不以 hasTitle 作为隔离条件。
  Object.assign(orchestrator, { hasTitle: () => false, generateTitleAsync: () => { throw new Error('title forbidden') } })
  const callbacks: SessionCallbacks = { onError: message => errors.push(message), onComplete: (messages, metadata) => completions.push({ messages, metadata }), onTitleUpdated() {} }
  return { orchestrator, queries, persisted, errors, completions, callbacks }
}
describe('Owner early orchestrator routing', () => {
  test('given polluted input then authority query bypasses all generic context and title paths', async () => {
    const h = harness(); await h.orchestrator.sendMessage(input, h.callbacks)
    expect(h.errors).toEqual([]); expect(h.queries).toHaveLength(1)
    expect(h.queries[0]).toMatchObject({ agentRuntime: 'ai-sdk', prompt: 'authority-user', systemPrompt: 'authority-system', permissionMode: 'safe', maxTurns: 1, maxRetries: 0 })
    expect(JSON.stringify(h.queries)).not.toContain('evil')
    expect({ dynamic, workspaceContext, history }).toEqual({ dynamic: 0, workspaceContext: 0, history: 0 })
    expect(h.persisted).toHaveLength(3); expect(h.completions).toHaveLength(1)
  })
  test('given bad evidence, mismatch or compact then no ordinary fallback query occurs', async () => {
    const h = harness(); broken = true
    try { await h.orchestrator.sendMessage(input, h.callbacks) } finally { broken = false }
    await h.orchestrator.sendMessage({ ...input, channelId: 'other' }, h.callbacks)
    await h.orchestrator.sendMessage({ ...input, userMessage: '/compact' }, h.callbacks)
    expect(h.queries).toHaveLength(0); expect(h.errors).toHaveLength(3)
  })
  test('given Owner steering then orchestrator rejects before mutating input queue or permission', async () => {
    const h = harness()
    await expect(h.orchestrator.queueMessage('owner', 'evil')).rejects.toThrow('Owner')
    await expect(h.orchestrator.updateSessionPermissionMode('owner', 'auto')).rejects.toThrow('Owner')
    expect(h.orchestrator.getQueuedMessageCount('owner')).toBe(0)
  })
})
