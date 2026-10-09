/** 离线捕获最终 Provider 请求与 AI SDK 调用参数，不调用真实 Provider。 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter, StreamSSEResult } from '@gravitas/core'
import type { AISDKRuntimeStreamResult } from './ai-sdk-runtime-core'
import { buildElectronMock } from '../testing/electron-mock'
import { isolateSteWritingHostDependencies } from '../testing/ste-writing-test-isolation'

isolateSteWritingHostDependencies()
mock.module('electron', () => buildElectronMock())
// 工具与 MCP 获取不是本测试目标：阻断桌面 bootstrap 的依赖链，而非屏蔽启动异常。
mock.module('./tool-registry', () => ({
  createCoreTools: () => [], ENTER_PLAN_MODE_TOOL_NAME: 'EnterPlanMode',
  EXIT_PLAN_MODE_TOOL_NAME: 'ExitPlanMode', ASK_USER_QUESTION_TOOL_NAME: 'AskUserQuestion',
  GOAL_CHECKPOINT_TOOL_NAME: 'GoalCheckpoint',
}))
mock.module('./runtime-mcp-service', () => ({ ElectronRuntimeMcpService: class {} }))
const requests: string[] = []
const providerAdapter: ProviderAdapter = {
  providerType: 'deepseek',
  buildStreamRequest: (input) => {
    requests.push(input.systemMessage ?? '')
    return { url: 'https://offline.invalid', headers: {}, body: '{}' }
  },
  parseSSELine: () => [],
  buildTitleRequest: () => ({ url: '', headers: {}, body: '' }),
  parseTitleResponse: () => null,
}
mock.module('@gravitas/core', () => ({
  getAdapter: () => providerAdapter,
  streamSSE: async (): Promise<StreamSSEResult> => ({ content: '离线完成', reasoning: '', thinkingBlocks: [], toolCalls: [], stopReason: 'end_turn' }),
}))
const dir = mkdtempSync(join(tmpdir(), 'ste-assembly-'))
const originalConfigDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = dir
const ownerPurposeStore = await import('../project-sqlite-store')
beforeAll(async () => { await ownerPurposeStore.initProjectDb() })
const { ProviderAgnosticAgentAdapter } = await import('../adapters/provider-agnostic-agent-adapter')
const { AISDKRuntimeCore } = await import('./ai-sdk-runtime-core')
const { setPluginEnabled, collectContributingPrompts } = await import('../plugin-manager')
const { buildSystemPrompt } = await import('../agent-prompt-builder')
afterAll(() => {
  ownerPurposeStore.closeProjectDb()
  rmSync(dir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfigDir
})
beforeEach(() => { requests.length = 0 })

function expectSte(prompt: string, enabled: boolean): void {
  expect(prompt.includes('STE 简化写作规范')).toBe(enabled)
  expect(prompt).toContain('安全')
}

describe('真实运行时提示装配（离线）', () => {
  test('Proma 默认提示与普通 SubAgent 角色提示都在最终 Provider 请求中收集当前插件状态', async () => {
    for (const enabled of [true, false, true]) {
      expect(await setPluginEnabled('com.gravitas.ste-writing', enabled)).not.toBeNull()
      for (const systemPrompt of [undefined, '你是只读审查员。只输出 schema 指定的 JSON；禁止委派子 Agent。']) {
        const adapter = new ProviderAgnosticAgentAdapter()
        try {
          for await (const message of adapter.query({
            sessionId: `offline-${enabled}-${systemPrompt ? 'child' : 'parent'}`,
            prompt: '离线任务', model: 'deepseek-chat', provider: 'deepseek', apiKey: 'offline',
            baseUrl: 'https://offline.invalid', cwd: dir, systemPrompt, disableTools: true,
            historyMessages: [], permissionMode: 'safe', maxTurns: 1,
          })) { expect(message.type).toBeDefined() }
        } finally { adapter.dispose() }
        const finalPrompt = requests.at(-1)!
        expectSte(finalPrompt, enabled)
        expect(finalPrompt).toContain(systemPrompt ?? '你是一个高效的编程助手')
        expect(finalPrompt).toContain('函数调用格式')
      }
    }
    expect(requests).toHaveLength(6)
  })

  test('AI SDK runAgentTurn 最终 stream 参数保留默认/角色、JSON 和工具规则，启停生效', async () => {
    const core = new AISDKRuntimeCore()
    const captured: string[] = []
    const offlineStream = {
      result: { steps: Promise.resolve([]), usage: Promise.resolve({ inputTokens: 0, outputTokens: 0, totalTokens: 0, inputTokenDetails: { cacheReadTokens: 0 }, outputTokenDetails: {} }) },
      streamedSteps: [],
    } as unknown as AISDKRuntimeStreamResult
    const stream = spyOn(core, 'runStreamTextWithRetry').mockImplementation(async (input) => {
      captured.push(input.system)
      return offlineStream
    })
    try {
      for (const enabled of [true, false]) {
        await setPluginEnabled('com.gravitas.ste-writing', enabled)
        for (const systemPrompt of [undefined, '保留角色：只输出 JSON，不得调用子 Agent。']) {
          await core.runAgentTurn({
            sessionId: 'offline-ai', prompt: '离线', modelId: 'deepseek-chat', provider: 'deepseek',
            protocol: 'openai-chat', apiKey: 'offline', baseUrl: 'https://offline.invalid', cwd: dir,
            runtimeTools: [], activeSession: { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false },
            systemPrompt, maxTurns: 1, maxRetries: 0,
          })
          const finalPrompt = captured.at(-1)!
          expectSte(finalPrompt, enabled)
          expect(finalPrompt).toContain(systemPrompt ?? '你是一个高效的编程助手')
          expect(finalPrompt).toContain('函数调用格式')
        }
      }
    } finally { stream.mockRestore() }
    expect(captured).toHaveLength(4)
  })

  test('Pi/Claude 共用最终系统提示构建器收到真实 collector 的片段，停用不留下 STE 备份', async () => {
    for (const enabled of [true, false]) {
      await setPluginEnabled('com.gravitas.ste-writing', enabled)
      const finalPrompt = buildSystemPrompt({
        sessionId: 'offline-pi-claude', permissionMode: 'safe', memoryEnabled: false,
        claudeAvailable: false, collaborationAvailable: false,
        pluginToolPrompts: collectContributingPrompts(),
      })
      expectSte(finalPrompt, enabled)
      expect(finalPrompt).toContain('工具使用指南')
    }
  })
})
