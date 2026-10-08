import { beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const boundaryTestDir = mkdtempSync(join(tmpdir(), 'gravitas-pi-boundary-'))
const originalBoundaryDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = boundaryTestDir
const boundaryStore = await import('../project-sqlite-store')
beforeAll(async () => { await boundaryStore.initProjectDb() })
afterAll(() => { boundaryStore.closeProjectDb(); if (originalBoundaryDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = originalBoundaryDir; rmSync(boundaryTestDir, { recursive: true, force: true }) })
import { describe, expect, mock, test } from 'bun:test'
import { buildElectronMock } from '../testing/electron-mock'
import type { Context, Model } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import type { AgentEvent } from '@gravitas/shared'


mock.module('electron', () => buildElectronMock())

mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  readAttachmentAsBase64: () => 'AQID',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock.png', mimeType: 'image/png', size: 1 }),
}))

mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async (localPath: string) => `文档内容：${localPath}`,
}))

let capturedSessionOptions: { noTools?: 'builtin'; customTools?: Array<{ name: string }> } | undefined
let capturedAgent: {
  toolExecution: string
  prepareRequest?: (request: { context: { messages: unknown[] } }, signal?: AbortSignal) => Promise<unknown>
  onPayload?: (payload: unknown, model: unknown) => Promise<unknown>
  beforeToolCall?: (context: { toolCall: { name: string } }, signal?: AbortSignal) => Promise<{ block?: boolean; terminate?: boolean } | undefined>
} | undefined
let previousPrepareCalls = 0
let previousPayloadCalls = 0
let previousToolCalls = 0
let mockBeforePrompt: (() => Promise<void>) | undefined
let mockAfterPrompt: (() => Promise<void>) | undefined
let capturedSettings: { images?: { blockImages?: boolean }; compaction?: { enabled?: boolean }; retry?: { enabled?: boolean; provider?: { maxRetries?: number } }; cacheWarming?: 'streaming' | 'off' } | undefined
let capturedSystemPromptOverride: (() => string) | undefined
let promptGate: Promise<void> | undefined
let abortCallCount = 0
let disposeCallCount = 0
let sessionActivated = false
interface MockPiEvent {
  type: string
  message?: unknown
  messages?: []
  [key: string]: unknown
}
let promptEvents: MockPiEvent[] = []
let promptEventBatches: MockPiEvent[][] = []
let promptCallCount = 0
let promptErrors: Error[] = []
interface CapturedPiPrompt {
  text: string
  options?: {
    expandPromptTemplates?: boolean
    images?: Array<{ type: 'image'; data: string; mimeType: string }>
  }
}
let capturedPrompts: CapturedPiPrompt[] = []

function getCapturedSessionOptions(): { noTools?: 'builtin'; customTools?: Array<{ name: string }> } | undefined {
  return capturedSessionOptions
}

function getCapturedSettings(): typeof capturedSettings {
  return capturedSettings
}

function getCapturedSystemPrompt(): string {
  return capturedSystemPromptOverride?.() ?? ''
}

mock.module('./pi-sdk-loader', () => ({
  loadPiCodingAgent: async () => ({
    DefaultResourceLoader: class {
      constructor(options: { systemPromptOverride?: () => string }) {
        capturedSystemPromptOverride = options.systemPromptOverride
      }
      async reload(): Promise<void> {}
      getExtensions() { return { extensions: [], errors: [] } }
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: {
      inMemory: (settings: NonNullable<typeof capturedSettings>) => {
        capturedSettings = settings
        return {}
      },
    },
    createAgentSession: async (options: { noTools?: 'builtin'; customTools?: Array<{ name: string }> }) => {
      capturedSessionOptions = options
      sessionActivated = true
      const listeners: Array<(event: MockPiEvent) => void> = []
      const state: { messages: unknown[] } = { messages: [] }
      const agent = {
        toolExecution: 'parallel',
        prepareRequest: async () => { previousPrepareCalls++; return undefined },
        onPayload: async (payload: unknown) => { previousPayloadCalls++; return payload },
        beforeToolCall: async () => { previousToolCalls++; return undefined },
      }
      capturedAgent = agent
      return {
        session: {
          state,
          agent,
          getActiveToolNames: () => options.customTools?.map((tool) => tool.name) ?? [],
          subscribe(listener: (event: MockPiEvent) => void) {
            listeners.push(listener)
            return () => {}
          },
          async prompt(text: string, options?: CapturedPiPrompt['options']) {
            if (mockBeforePrompt) await mockBeforePrompt()
            capturedPrompts.push({ text, options })
            const promptError = promptErrors.shift()
            if (promptError) {
              promptCallCount += 1
              throw promptError
            }
            await promptGate
            promptCallCount += 1
            const events = promptEventBatches.shift() ?? promptEvents
            for (const event of events) {
              if (event.type === 'message_end' && event.message) state.messages.push(event.message)
              for (const listener of listeners) listener(event)
            }
            for (const listener of listeners) listener({ type: 'agent_end', messages: [] })
            if (mockAfterPrompt) await mockAfterPrompt()
          },
          async abort() { abortCallCount += 1 },
          dispose() { disposeCallCount += 1 },
        },
      }
    },
  }),
}))

const actualPiModelRegistry = await import('./pi-model-registry')

mock.module('./pi-model-registry', () => ({
  ...actualPiModelRegistry,
  registerPiModelFromChannel: async () => ({
    agentDir: '/tmp/pi-agent',
    modelRuntime: {},
    model: {},
  }),
}))

const { PiAgentAdapter, resolveFirstTokenTimeoutMs, resolvePromptIdleTimeoutMs, PI_PROMPT_FIRST_TOKEN_MAX_TIMEOUT_MS } = await import('./pi-agent-adapter')

describe('resolveFirstTokenTimeoutMs（首 token 宽限自适应）', () => {
  test('小上下文用流中空闲阈值下限（120s）', () => {
    expect(resolveFirstTokenTimeoutMs(0)).toBe(120_000)
    expect(resolveFirstTokenTimeoutMs(50_000)).toBe(120_000)
  })

  test('按 500 tokens/s 线性放大：16 万 token → 320s', () => {
    expect(resolveFirstTokenTimeoutMs(160_000)).toBe(320_000)
  })

  test('超大上下文封顶 480s', () => {
    expect(resolveFirstTokenTimeoutMs(10_000_000)).toBe(PI_PROMPT_FIRST_TOKEN_MAX_TIMEOUT_MS)
  })

  test('工具/重试活动不结束首 token 阶段，真实模型活动后才回到 120s', () => {
    expect(resolvePromptIdleTimeoutMs(false, 320_000)).toBe(320_000)
    expect(resolvePromptIdleTimeoutMs(true, 320_000)).toBe(120_000)
  })
})

describe('PiAgentAdapter', () => {
  test('given required channel fields are missing then query fails with a helpful error', async () => {
    const adapter = new PiAgentAdapter()

    await expect(async () => {
      for await (const _message of adapter.query({ sessionId: 's-pi', prompt: 'hello', agentRuntime: 'pi' })) {
        // 配置不完整，不应产出消息。
      }
    }).toThrow('Pi Runtime 需要 provider、apiKey、baseUrl、model、cwd')
  })

  test('abort and dispose are safe when no Pi session is active', () => {
    const adapter = new PiAgentAdapter()

    expect(() => adapter.abort('s-pi')).not.toThrow()
    expect(() => adapter.dispose()).not.toThrow()
  })

  test('given the user requests compact when Pi handles the turn then compaction runs directly without prompting the model', async () => {
    capturedPrompts = []
    const events: AgentEvent[] = []
    const adapter = new PiAgentAdapter()

    for await (const _message of adapter.query({
      sessionId: 's-pi-manual-compact',
      prompt: '/compact',
      requestedOperation: 'compact',
      agentRuntime: 'pi',
      provider: 'deepseek',
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'test-model',
      cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
      onAgentEvent: (event) => events.push(event),
    })) {
      // 手动压缩不应进入普通模型 prompt。
    }

    expect(capturedPrompts).toEqual([])
    expect(events).toEqual([
      { type: 'compaction_status', status: 'started' },
      { type: 'compaction_status', status: 'noop', message: '当前上下文较小，暂时无需压缩。' },
    ])
  })

  test('Pi 有限费用模式下手动 compact 在 Provider/会话初始化前被拒绝', async () => {
    capturedPrompts = []
    const adapter = new PiAgentAdapter()
    await expect(async () => {
      for await (const _message of adapter.query({
        sessionId: 's-pi-compact-budget', prompt: '/compact', requestedOperation: 'compact', agentRuntime: 'pi',
        provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
        model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
      })) { /* 费用模式不得进入模型 */ }
    }).toThrow('禁止未纳入请求门禁的压缩调用')
    expect(capturedPrompts).toEqual([])
  })

  test('given Pi starts a session when P0 tools are configured then Pi built-ins are disabled and only the Proma bridge is enabled', async () => {
    capturedSessionOptions = undefined
    capturedSettings = undefined
    capturedSystemPromptOverride = undefined
    promptGate = undefined
    promptEvents = []
    promptEventBatches = []
    promptCallCount = 0
    capturedPrompts = []
    const adapter = new PiAgentAdapter()

    for await (const _message of adapter.query({
      sessionId: 's-pi-bridge',
      prompt: '读取 README.md',
      agentRuntime: 'pi',
      provider: 'deepseek',
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'test-model',
      cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
    })) {
      // mock session 不返回消息。
    }

    const sessionOptions = getCapturedSessionOptions()
    if (!sessionOptions) throw new Error('Pi session 未创建')
    expect(sessionOptions.noTools).toBe('builtin')
    expect(sessionOptions.customTools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'Read', 'Write', 'Edit', 'Grep', 'Bash',
      'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'Agent',
      'WebSearch', 'WebFetch',
      'RecallMemory', 'AddMemory',
      'WebBridgeSnapshot', 'ComputerUseScreenshot',
    ]))
    expect(sessionOptions.customTools?.some((tool) => tool.name === 'bash')).toBe(false)
    expect(sessionOptions.customTools?.some((tool) => tool.name === 'CompactContext')).toBe(false)
    expect(getCapturedSettings()?.compaction?.enabled).toBe(false)
    expect(getCapturedSettings()?.retry?.enabled).toBe(true)
    expect(getCapturedSettings()?.retry?.provider?.maxRetries).toBeUndefined()
    expect(getCapturedSettings()?.cacheWarming).toBe('streaming')
    expect(getCapturedSettings()?.images?.blockImages).toBe(false)
    expect(getCapturedSystemPrompt()).toContain('使用 WebSearch 或 WebFetch')
    expect(getCapturedSystemPrompt()).toContain('征求同意')
    expect(getCapturedSystemPrompt()).toContain('绝不能先调用 WebBridgeScreenshot')
  })

  test('有调用级预算时安装 Pi 请求/工具钩子并保留 coding-agent 原钩子；缺费阻断下一请求及工具', async () => {
    promptEvents = [{ type: 'message_end', message: {
      role: 'assistant', usage: { cost: { total: Number.NaN } }, stopReason: 'stop', content: [],
    } }]
    previousPrepareCalls = 0
    previousToolCalls = 0
    const adapter = new PiAgentAdapter()
    await expect(async () => {
      for await (const _message of adapter.query({
        sessionId: 's-pi-budget-hooks', prompt: '离线预算', agentRuntime: 'pi',
        provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
        model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
      })) { /* mock 不触发真实 Provider */ }
    }).toThrow('Pi 有限费用执行待对账')
    expect(capturedAgent?.prepareRequest).toBeDefined()
    expect(getCapturedSettings()?.retry?.enabled).toBe(false)
    expect(getCapturedSettings()?.retry?.provider?.maxRetries).toBe(0)
    expect(getCapturedSettings()?.cacheWarming).toBe('off')
    const request = { context: { messages: [] } }
    // query 已结束；从订阅事件观察到费用未知，预算快照必须拒绝后续请求。
    await expect(capturedAgent?.prepareRequest?.(request)).rejects.toThrow('费用门禁阻断')
    expect(previousPrepareCalls).toBe(0) // 已有阻断时不得先跑旧 hook
    expect(await capturedAgent?.beforeToolCall?.({ toolCall: { name: 'Write' } })).toMatchObject({ block: true, terminate: true })
    expect(previousToolCalls).toBe(0)
    promptEvents = []
  })

  test('有限费用请求体必须已有请求准入；无准入不能调用既有 payload 钩子', async () => {
    promptEvents = []
    previousPayloadCalls = 0
    mockBeforePrompt = async () => {
      await expect(capturedAgent?.onPayload?.({ model: 'test-model' }, {})).rejects.toThrow('Provider 请求体门禁阻断')
      expect(previousPayloadCalls).toBe(0)
    }
    try {
      const adapter = new PiAgentAdapter()
      await expect(async () => {
        for await (const _message of adapter.query({
          sessionId: 's-pi-payload-gate', prompt: '离线请求体', agentRuntime: 'pi',
          provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
          model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
        })) { /* 离线 mock */ }
      }).toThrow('Provider 请求体没有有效的模型请求准入')
    } finally { mockBeforePrompt = undefined }
  })

  test('Pi 预算钩子拒绝没有请求准入的回执；不得把费用看似有效当作工具放行', async () => {
    promptEvents = [{ type: 'message_end', message: {
      role: 'assistant', usage: { cost: { total: 0.1 } }, stopReason: 'stop', content: [],
    } }]
    previousToolCalls = 0
    const adapter = new PiAgentAdapter()
    await expect(async () => {
      for await (const _message of adapter.query({
        sessionId: 's-pi-budget-allowed', prompt: '离线预算', agentRuntime: 'pi',
        provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
        model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
      })) { /* mock 不触发真实 Provider */ }
    }).toThrow('Pi 有限费用执行待对账')
    // mock 不执行 SDK 的 prepareRequest；无准入的费用回执必须 fail-closed。
    expect(await capturedAgent?.beforeToolCall?.({ toolCall: { name: 'Read' } })).toMatchObject({ block: true })
    expect(previousToolCalls).toBe(0)
    promptEvents = []
  })

  test('Pi adapter 已准入请求但没有费用回执时，正常 resolve 仍不得报告完成', async () => {
    promptEvents = []
    mockBeforePrompt = async () => { await capturedAgent?.prepareRequest?.({ context: { messages: [] } }) }
    try {
      const adapter = new PiAgentAdapter()
      await expect(async () => {
        for await (const _message of adapter.query({
          sessionId: 's-pi-budget-no-receipt', prompt: '离线预算', agentRuntime: 'pi',
          provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
          model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
        })) { /* mock 不触发真实 Provider */ }
      }).toThrow('模型请求没有 Runtime 费用回执')
    } finally { mockBeforePrompt = undefined }
  })

  test('Pi adapter 费用达到阈值后 prompt 虽正常 resolve，也不得向外报告完成', async () => {
    promptEvents = [{ type: 'message_end', message: {
      role: 'assistant', usage: { cost: { total: 0.5 } }, stopReason: 'stop', content: [],
    } }]
    mockBeforePrompt = async () => { await capturedAgent?.prepareRequest?.({ context: { messages: [] } }) }
    try {
      const adapter = new PiAgentAdapter()
      await expect(async () => {
        for await (const _message of adapter.query({
          sessionId: 's-pi-budget-at-limit', prompt: '离线预算', agentRuntime: 'pi',
          provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
          model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
        })) { /* mock 不触发真实 Provider */ }
      }).toThrow('Pi 有限费用执行待对账')
    } finally { mockBeforePrompt = undefined; promptEvents = [] }
  })

  test('Pi adapter 按请求前准入计费且保留 coding-agent 原工具钩子', async () => {
    promptEvents = [{ type: 'message_end', message: {
      role: 'assistant', usage: { cost: { total: 0.1 } }, stopReason: 'stop', content: [],
    } }]
    previousPrepareCalls = 0
    previousPayloadCalls = 0
    previousToolCalls = 0
    mockBeforePrompt = async () => {
      await capturedAgent?.prepareRequest?.({ context: { messages: [] } })
      expect(await capturedAgent?.onPayload?.({ model: 'test-model' }, {})).toEqual({ model: 'test-model' })
    }
    mockAfterPrompt = async () => {
      expect(await capturedAgent?.beforeToolCall?.({ toolCall: { name: 'Read' } })).toBeUndefined()
    }
    try {
      const adapter = new PiAgentAdapter()
      for await (const _message of adapter.query({
        sessionId: 's-pi-budget-admitted', prompt: '离线预算', agentRuntime: 'pi',
        provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
        model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
      })) { /* mock 不触发真实 Provider */ }
      expect(previousPrepareCalls).toBe(1)
      expect(previousPayloadCalls).toBe(1)
      expect(previousToolCalls).toBe(1)
    } finally { mockBeforePrompt = undefined; mockAfterPrompt = undefined; promptEvents = [] }
  })

  test('given a user uploads a JPEG when Pi sends the turn then the model receives the real image block', async () => {
    capturedPrompts = []
    const adapter = new PiAgentAdapter()

    for await (const _message of adapter.query({
      sessionId: 's-pi-jpeg',
      prompt: '理解这幅图',
      agentRuntime: 'pi',
      provider: 'custom',
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash-vision-exp',
      cwd: '/tmp',
      attachments: [{
        id: 'jpeg-1',
        filename: 'photo.jpg',
        mediaType: 'image/jpeg',
        size: 3,
        localPath: '/tmp/photo.jpg',
      }],
    })) {
      // mock session 不返回消息。
    }

    expect(capturedPrompts).toEqual([{
      text: '理解这幅图',
      options: {
        expandPromptTemplates: false,
        images: [{ type: 'image', data: 'AQID', mimeType: 'image/jpeg' }],
      },
    }])

    const sentPrompt = capturedPrompts[0]
    if (!sentPrompt) throw new Error('Pi 未生成 prompt')
    let finalPayload: Record<string, unknown> | undefined
    const model: Model<'openai-completions'> = {
      id: 'deepseek-v4-flash-vision-exp',
      name: 'deepseek-v4-flash-vision-exp',
      api: 'openai-completions',
      provider: 'custom',
      baseUrl: 'https://api.deepseek.com/v1',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    }
    const context: Context = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: sentPrompt.text },
          ...(sentPrompt.options?.images ?? []),
        ],
        timestamp: 1,
      }],
    }
    const serialized = streamSimple(model, normalizeContext(context), {
      apiKey: 'test-key',
      onPayload: (payload) => {
        finalPayload = payload as Record<string, unknown>
        throw new Error('payload captured')
      },
    })
    await serialized.result()

    const apiMessages = finalPayload?.messages as Array<Record<string, unknown>> | undefined
    expect(apiMessages?.at(-1)?.content).toEqual([
      { type: 'text', text: '理解这幅图' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
    ])
  })

  test('given Pi emits completed messages before agent_end then messages are forwarded without waiting for final replay', async () => {
    promptEvents = [{
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '工具完成后的说明' }],
        usage: { input: 1, output: 2, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        model: 'test-model',
        stopReason: 'stop',
      },
    }]
    const adapter = new PiAgentAdapter()
    const messages = []

    for await (const message of adapter.query({
      sessionId: 's-pi-stream',
      prompt: '完成工具后说明',
      agentRuntime: 'pi',
      provider: 'deepseek',
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'test-model',
      cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
    })) {
      messages.push(message)
    }

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '工具完成后的说明' }] },
    })
    promptEvents = []
  })

  test('given Pi completes a native tool loop then tool results and the final summary are forwarded from one prompt', async () => {
    promptCallCount = 0
    promptEventBatches = [[
      {
        type: 'message_end',
        message: {
          role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'Write', arguments: { file_path: 'test.md', content: '内容' } }],
          usage: { input: 1, output: 2, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          model: 'test-model', stopReason: 'toolUse', timestamp: Date.now(),
        },
      }, {
        type: 'message_end',
        message: {
          role: 'toolResult', toolCallId: 'write-1', toolName: 'Write', isError: false,
          content: [{ type: 'text', text: '文件已写入' }], timestamp: Date.now(),
        },
      }, {
        type: 'message_end',
        message: {
          role: 'assistant', content: [{ type: 'text', text: '已完成，并已写入 test.md。' }],
          usage: { input: 2, output: 3, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          model: 'test-model', stopReason: 'stop', timestamp: Date.now(),
        },
      },
    ]]
    const adapter = new PiAgentAdapter()
    const messages = []

    for await (const message of adapter.query({
      sessionId: 's-pi-tool-continuation', prompt: '写入 test.md 后总结', agentRuntime: 'pi',
      provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test', model: 'test-model', cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
    })) {
      messages.push(message)
    }

    expect(promptCallCount).toBe(1)
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user' }),
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [{ type: 'text', text: '已完成，并已写入 test.md。' }] }) }),
    ]))
    promptEventBatches = []
  })

  test('given Pi streams an assistant message then it emits a partial snapshot before the final message', async () => {
    promptEvents = [
      {
        type: 'message_update',
        message: {
          role: 'assistant', content: [{ type: 'text', text: '正在总结' }],
          usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          model: 'test-model', stopReason: 'stop', timestamp: Date.now(),
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant', content: [{ type: 'text', text: '正在总结，操作完成。' }],
          usage: { input: 1, output: 2, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          model: 'test-model', stopReason: 'stop', timestamp: Date.now(),
        },
      },
    ]
    const adapter = new PiAgentAdapter()
    const messages: Array<Record<string, unknown>> = []

    for await (const message of adapter.query({
      sessionId: 's-pi-partial', prompt: '总结', agentRuntime: 'pi',
      provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test', model: 'test-model', cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
    })) {
      messages.push(message as Record<string, unknown>)
    }

    expect(messages.some((message) => message._partial === true)).toBe(true)
    expect(messages.some((message) => message.type === 'assistant' && message._partial !== true)).toBe(true)
    promptEvents = []
  })

  test('given Pi schedules a native retry then it hides the transient error and reports retry lifecycle', async () => {
    promptEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant', content: [{ type: 'text', text: '暂态输出' }],
          usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          model: 'test-model', stopReason: 'error', errorMessage: '网络暂时中断', timestamp: Date.now(),
        },
      },
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: '网络暂时中断' },
      { type: 'auto_retry_end', success: true, attempt: 1 },
      {
        type: 'message_end',
        message: {
          role: 'assistant', content: [{ type: 'text', text: '重试成功后的总结' }],
          usage: { input: 2, output: 2, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          model: 'test-model', stopReason: 'stop', timestamp: Date.now(),
        },
      },
    ]
    const adapter = new PiAgentAdapter()
    const messages = []
    const events: Array<{ type: string }> = []

    for await (const message of adapter.query({
      sessionId: 's-pi-retry', prompt: '重试', agentRuntime: 'pi',
      provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test', model: 'test-model', cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
      onAgentEvent: (event) => events.push(event),
    })) {
      messages.push(message)
    }

    expect(messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ error: expect.anything() }),
    ]))
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistant', message: expect.objectContaining({ content: [{ type: 'text', text: '重试成功后的总结' }] }) }),
    ]))
    expect(events.map((event) => event.type)).toEqual(['retrying', 'retry_cleared'])
    promptEvents = []
  })

  test('given Pi retries a disconnected prompt when the user uploaded a JPEG then the recovered turn does not inject the image twice', async () => {
    capturedPrompts = []
    promptErrors = [new Error('fetch failed: socket hang up')]
    promptEvents = []
    const adapter = new PiAgentAdapter()

    for await (const _message of adapter.query({
      sessionId: 's-pi-image-retry',
      prompt: '理解这幅图',
      agentRuntime: 'pi',
      provider: 'deepseek',
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'deepseek-v4-flash-vision-exp',
      cwd: '/tmp',
      attachments: [{
        id: 'jpeg-retry',
        filename: 'photo.jpg',
        mediaType: 'image/jpeg',
        size: 3,
        localPath: '/tmp/photo.jpg',
      }],
      canUseTool: async () => ({ allowed: true }),
    })) {
      // 首次断流后由同一 Pi session 恢复。
    }

    expect(capturedPrompts).toHaveLength(2)
    expect(capturedPrompts[0]?.options?.images).toEqual([
      { type: 'image', data: 'AQID', mimeType: 'image/jpeg' },
    ])
    expect(capturedPrompts[1]?.options?.images).toBeUndefined()
    promptErrors = []
  })

  test('有限费用模式下 prompt 断流不得由 adapter 再次调用 Pi；费用未知需人工对账', async () => {
    capturedPrompts = []
    promptErrors = [new Error('fetch failed: socket hang up')]
    promptEvents = []
    const adapter = new PiAgentAdapter()
    try {
      await expect(async () => {
        for await (const _message of adapter.query({
          sessionId: 's-pi-budget-retry', prompt: '离线断流', agentRuntime: 'pi',
          provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test',
          model: 'test-model', cwd: '/tmp', runtimeBudgetLimitUsd: 0.5,
        })) { /* mock 不触发真实 Provider */ }
      }).toThrow('fetch failed')
      expect(capturedPrompts).toHaveLength(1)
    } finally { promptErrors = []; promptEvents = [] }
  })

  test('given native compaction ends without a result then it does not emit a false compact boundary', async () => {
    promptEvents = [
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', aborted: false, errorMessage: 'Auto-compaction failed' },
    ]
    const adapter = new PiAgentAdapter()
    const messages = []

    for await (const message of adapter.query({
      sessionId: 's-pi-compaction-failed', prompt: '继续', agentRuntime: 'pi',
      provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://example.test', model: 'test-model', cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
    })) {
      messages.push(message)
    }

    expect(messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system', subtype: 'compact_boundary' }),
    ]))
    promptEvents = []
  })

  test('given an active Pi turn when it is cancelled then the Pi session is released', async () => {
    let resolvePrompt: (() => void) | undefined
    promptGate = new Promise<void>((resolve) => { resolvePrompt = resolve })
    abortCallCount = 0
    disposeCallCount = 0
    sessionActivated = false
    const adapter = new PiAgentAdapter()
    const iterator = adapter.query({
      sessionId: 's-pi-cancel',
      prompt: '等待取消',
      agentRuntime: 'pi',
      provider: 'deepseek',
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'test-model',
      cwd: '/tmp',
      canUseTool: async () => ({ allowed: true }),
    })[Symbol.asyncIterator]()
    const nextMessage = iterator.next()
    for (let attempt = 0; attempt < 10 && !sessionActivated; attempt += 1) {
      await Promise.resolve()
    }
    if (!sessionActivated) throw new Error('Pi session 未进入活动状态')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    adapter.abort('s-pi-cancel')
    resolvePrompt?.()
    await nextMessage
    adapter.abort('s-pi-cancel')

    expect(abortCallCount).toBe(1)
    expect(disposeCallCount).toBe(1)
    promptGate = undefined
  })
})
