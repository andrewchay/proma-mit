import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter } from '@gravitas/shared'
import type { RuntimeServices } from '../agent-runtime/runtime-services'
import { buildElectronMock } from '../testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'director-orchestrator-'))
const original = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
writeFileSync(join(directory, 'settings.json'), JSON.stringify({ newMediaCapabilities: ['content-operations'] }))
mock.module('electron', () => buildElectronMock())
mock.module('../token-usage-service', () => ({ tokenUsageService: { middleware: (_session: unknown, _event: unknown, next: () => void) => next(), start: () => {} } }))
interface CapturedQuery { model?: string; permissionMode?: string; systemPrompt?: string; prompt?: string; disableTools?: boolean; systemPromptMode?: string; thinkingLevel?: string }
let captured: CapturedQuery | undefined
function getCaptured(): CapturedQuery | undefined { return captured }
mock.module('../adapters/provider-agnostic-agent-adapter', () => ({
  ProviderAgnosticAgentAdapter: class {
    async *query(input: typeof captured) {
      captured = input
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '角色交付' }] } }
    }
    dispose() {}
  },
}))
const store = await import('../project-sqlite-store')
const { AgentOrchestrator } = await import('../agent-orchestrator')
const { AgentEventBus } = await import('../agent-event-bus')
beforeAll(() => store.initProjectDb())
afterAll(() => { store.closeProjectDb(); if (original === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = original; rmSync(directory, { recursive: true, force: true }) })

test('实际子代理编排将设计和文案收紧为只读，即使父会话允许所有操作', async () => {
  const adapter: AgentProviderAdapter = { async *query() {}, abort() {}, dispose() {} }
  const services: RuntimeServices = {
    credentials: { resolveChannel: async () => undefined },
    workspaces: { resolveWorkspaceContext: () => ({ cwd: directory }) },
    sessions: { getHistoryMessages: () => [], appendMessages: () => {}, truncateMessages: () => [] },
    events: { emit: () => {} }, mcp: { acquireClientManager: async () => { throw new Error('不应调用 MCP') } },
  }
  const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus(), services)
  for (const role of ['new-media-copywriter', 'new-media-designer']) {
    captured = undefined
    const result = await orchestrator['runProviderAgnosticSubAgent']('director-parent',
      { provider: 'openai', apiKey: 'fixture', baseUrl: 'https://example.invalid', model: 'fixture', cwd: directory, permissionMode: 'bypassPermissions' },
      { agentName: role, task: '已确认的创作任务' })
    expect(result).toBe('角色交付')
    const observed = getCaptured()
    expect(observed?.permissionMode).toBe('safe')
    expect(observed?.disableTools).toBe(true)
    expect(observed?.systemPromptMode).toBe('direct')
    expect(observed?.systemPrompt).toContain(role === 'new-media-designer' ? '设计师' : '文案')
    if (role === 'new-media-copywriter') {
      expect(observed?.systemPrompt).toContain('林桂枝方法')
      expect(observed?.systemPrompt).toContain('许舜英方法')
    }
    expect(observed?.prompt).toContain('已确认的创作任务')
    expect(observed?.thinkingLevel).toBeUndefined()
  }
  await orchestrator['runProviderAgnosticSubAgent']('director-parent',
    { provider: 'zhipu', apiKey: 'fixture', baseUrl: 'https://example.invalid', model: 'glm-5.3-flash', cwd: directory, permissionMode: 'safe' },
    { agentName: 'new-media-designer', task: '设计封面' })
  expect(getCaptured()?.thinkingLevel).toBe('low')
  const { updateSettings } = await import('../settings-service')
  updateSettings({ agentThinkingLevel: 'high' })
  await orchestrator['runProviderAgnosticSubAgent']('director-parent',
    { provider: 'zhipu', apiKey: 'fixture', baseUrl: 'https://example.invalid', model: 'glm-5.3-flash', cwd: directory, permissionMode: 'safe' },
    { agentName: 'new-media-designer', task: '设计封面' })
  expect(getCaptured()?.thinkingLevel).toBe('high')
  for (const level of ['off', 'max'] as const) {
    updateSettings({ agentThinkingLevel: level })
    await orchestrator['runProviderAgnosticSubAgent']('director-parent',
      { provider: 'zhipu', apiKey: 'fixture', baseUrl: 'https://example.invalid', model: 'glm-5.3-flash', cwd: directory, permissionMode: 'safe' },
      { agentName: 'new-media-designer', task: 'test cover' })
    expect(getCaptured()?.thinkingLevel).toBe(level)
  }
  for (const provider of ['openai', 'zhipu'] as const) {
    await orchestrator['runProviderAgnosticSubAgent']('director-parent',
      { provider, apiKey: 'fixture', baseUrl: 'https://example.invalid', model: provider === 'openai' ? 'glm-5.3-flash' : 'other-model', cwd: directory, permissionMode: 'safe' },
      { agentName: 'new-media-designer', task: 'test cover' })
    expect(getCaptured()?.thinkingLevel).toBeUndefined()
  }
})

test('Pi 会话恢复模型后，委派角色使用同一个模型', async () => {
  const { createAgentSession } = await import('../agent-session-manager')
  const session = createAgentSession('总监恢复测试', 'channel', undefined, 'glm-5.3-flash', 'pi')
  const { updateSettings } = await import('../settings-service')
  updateSettings({ agentThinkingLevel: 'high' })
  let parentModel: string | undefined
  const adapter: AgentProviderAdapter = {
    async *query(input) {
      const pi = input as import('../adapters/pi-agent-adapter').PiAgentQueryOptions
      parentModel = pi.model
      await pi.toolContextOverrides?.runSubAgent?.({ agentName: 'new-media-designer', task: '制作封面' })
    },
    abort() {}, dispose() {},
  }
  const services: RuntimeServices = {
    credentials: { resolveChannel: async () => undefined },
    workspaces: { resolveWorkspaceContext: () => ({ cwd: directory }) },
    sessions: { getHistoryMessages: () => [], appendMessages: () => {}, truncateMessages: () => [] },
    events: { emit: () => {} }, mcp: { acquireClientManager: async () => { throw new Error('不应调用 MCP') } },
  }
  const orchestrator = new AgentOrchestrator(adapter, new AgentEventBus(), services)
  captured = undefined
  await orchestrator['runPiAgent']({ sessionId: session.id, channelId: 'channel', userMessage: '', prompt: '继续',
    provider: 'zhipu', apiKey: 'fixture', baseUrl: 'https://example.invalid',
    callbacks: { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} } })
  expect(parentModel).toBe('glm-5.3-flash')
  expect(getCaptured()?.model).toBe('glm-5.3-flash')
  expect(getCaptured()?.thinkingLevel).toBe('high')
})
