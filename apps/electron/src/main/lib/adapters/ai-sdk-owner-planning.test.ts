import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'
import type { AISDKAgentQueryOptions } from './ai-sdk-agent-adapter'

const dir = mkdtempSync(join(tmpdir(), 'owner-sdk-'))
process.env.PROMA_TEST_CONFIG_DIR = dir
afterAll(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })
let tools = 0, compact = 0, enriched = 0, pilot = 0, mcp = 0
let fail = false
let captured: Record<string, unknown>[] = []
let release: (() => void) | undefined
let block = false
const source = { binding: { modelId: 'bound-model', runtime: 'ai-sdk', workspaceId: 'ws', channelId: 'channel' }, request: { systemPrompt: 'authority-system', userPrompt: 'authority-user' }, sessionId: 'owner' }
mock.module('electron', () => buildElectronMock())
mock.module('../project-owner-planning-source', () => ({ resolveOwnerPlanningSession: (id: string) => id === 'owner' ? source : null }))
mock.module('../controlled-provider-boundary', () => ({ isControlledProviderSession: () => true, createControlledProviderFetch: () => globalThis.fetch, assertControlledPermissionChange: () => {} }))
mock.module('../channel-manager', () => ({ getChannelById: () => ({ provider: 'openai', baseUrl: 'https://example.invalid/v1' }), decryptApiKey: () => 'fake' }))
mock.module('../agent-workspace-manager', () => ({ getAgentWorkspace: () => ({}), getAgentWorkspaceCwd: () => dir, getWorkspaceSkills: () => { enriched++; return [] } }))
mock.module('../proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('../proxy-fetch', () => ({ getFetchFn: () => globalThis.fetch }))
mock.module('../project-pilot-request-exit', () => ({ resolvePilotBudgetForSession: () => { pilot++; return undefined }, buildPilotRequestRuntime: () => { pilot++; throw new Error('Pilot forbidden') } }))
mock.module('../agent-runtime/tool-registry', () => ({
  createCoreTools: () => { tools++; return [] }, GOAL_CHECKPOINT_TOOL_NAME: 'GoalCheckpoint', ASK_USER_QUESTION_TOOL_NAME: 'AskUserQuestion', ENTER_PLAN_MODE_TOOL_NAME: 'EnterPlanMode', EXIT_PLAN_MODE_TOOL_NAME: 'ExitPlanMode',
}))
mock.module('../agent-runtime/context-compaction', () => ({ COMPACT_CONTEXT_TOOL_NAME: 'CompactContext', compactSessionNow: async () => { compact++; throw new Error('compact forbidden') }, maybeAutoCompact: async () => { compact++; throw new Error('compact forbidden') } }))
mock.module('../agent-runtime/attachment-enrichment', () => ({ enrichHistoryWithDocuments: async () => { enriched++; return [] }, enrichMessageWithDocuments: async () => { enriched++; return 'polluted' }, getImageAttachmentData: () => { enriched++; return [] } }))
mock.module('@gravitas/core/providers/ai-sdk-bridge', () => ({ createAgentAISDKModel: () => ({}), AISDKStreamStepAccumulator: class { consume(part: { type: string }) { return part.type === 'finish-step' ? [{ text: 'raw-answer', toolCalls: [], toolResults: [], finishReason: 'stop' }] : [] } } }))
mock.module('ai', () => ({ isStepCount: (count: number) => ({ count }), jsonSchema: (v: unknown) => v, tool: (v: unknown) => v,
  streamText: (input: Record<string, unknown>) => { captured.push(input); return {
    stream: (async function* () { if (block) await new Promise<void>(r => { release = r }); if (fail) throw new Error('context length exceeded'); yield { type: 'text-delta', text: 'raw-answer' }; yield { type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 3, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 } } } })(),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 3, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 } }), steps: Promise.resolve([]), text: Promise.resolve('raw-answer'), finishReason: Promise.resolve('stop'),
  } },
}))
const { AISDKAgentAdapter } = await import('./ai-sdk-agent-adapter')
function input(): AISDKAgentQueryOptions { return { sessionId: 'owner', prompt: '/skill:evil user override', systemPrompt: 'evil-system', model: 'bound-model', provider: 'openai', apiKey: 'fake', baseUrl: 'https://example.invalid/v1', cwd: dir, historyMessages: [{ type: 'user', message: { content: 'evil-history' } } as never], skillMentions: ['evil'], attachments: [{ name: 'evil' } as never], extraTools: [{ name: 'evil', description: '', parameters: {}, execute: async () => 'evil' }], mcpServers: { evil: { type: 'stdio', command: 'evil', enabled: true } }, workspaceSlug: 'evil', maxRetries: 9, maxTurns: 9 } }
function adapter() { return new AISDKAgentAdapter({ acquireClientManager: async () => { mcp++; throw new Error('MCP forbidden') } } as never) }
async function collect(a: InstanceType<typeof AISDKAgentAdapter>, i = input()) { const out = []; for await (const msg of a.query(i)) out.push(msg); return out }
describe('Owner authority-only AI SDK turn', () => {
  test('given polluted generic inputs then only authority prompts and zero capabilities reach one model call', async () => {
    captured = []; const messages = await collect(adapter())
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ system: 'authority-system', messages: [{ role: 'user', content: 'authority-user' }], tools: {}, maxOutputTokens: 4096, maxRetries: 0, stopWhen: { count: 1 } })
    expect({ tools, compact, enriched, pilot, mcp }).toEqual({ tools: 0, compact: 0, enriched: 0, pilot: 0, mcp: 0 })
    expect(JSON.stringify(messages)).toContain('raw-answer')
    expect(messages.at(-1)).toMatchObject({ type: 'result', usage: { input_tokens: 10, output_tokens: 3 } })
  })
  test('given overflow then no compaction or hidden retry occurs', async () => {
    captured = []; fail = true
    try { const messages = await collect(adapter()); expect(messages.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution', finish_reason: 'error' }); expect(JSON.stringify(messages.at(-1))).toContain('context length exceeded'); expect(captured).toHaveLength(1); expect(compact).toBe(0) } finally { fail = false }
  })
  test('given manual compaction or binding mismatch then no model call occurs', async () => {
    captured = []; await expect(collect(adapter(), { ...input(), requestedOperation: 'compact' })).rejects.toThrow('Owner')
    await expect(collect(adapter(), { ...input(), model: 'other' })).rejects.toThrow('Owner'); expect(captured).toHaveLength(0)
  })
  test('given live Owner then steering is rejected rather than queued into a second request', async () => {
    captured = []; block = true; const a = adapter(); const pending = collect(a)
    while (!release) await new Promise(r => setTimeout(r, 1))
    try {
      await expect(a.interruptQuery('owner')).rejects.toThrow('Owner')
      await expect(a.setPermissionMode('owner', 'auto')).rejects.toThrow('Owner')
      await expect(a.sendQueuedMessage('owner', { uuid: 'q', message: { content: 'evil' } } as never)).rejects.toThrow('Owner')
    } finally { block = false; release?.(); release = undefined }
    await pending; expect(captured).toHaveLength(1)
  })
})
