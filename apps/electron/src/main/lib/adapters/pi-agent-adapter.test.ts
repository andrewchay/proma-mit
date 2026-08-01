import { describe, expect, mock, test } from 'bun:test'

class MockBrowserWindow {}

mock.module('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  },
  shell: { openExternal: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString('utf-8'),
  },
}))

mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  readAttachmentAsBase64: (localPath: string) => `base64:${localPath}`,
}))

mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async (localPath: string) => `文档内容：${localPath}`,
}))

let capturedSessionOptions: { noTools?: 'builtin'; customTools?: Array<{ name: string }> } | undefined
let capturedSettings: { images?: { blockImages?: boolean } } | undefined
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

function getCapturedSessionOptions(): { noTools?: 'builtin'; customTools?: Array<{ name: string }> } | undefined {
  return capturedSessionOptions
}

function getCapturedSettings(): { images?: { blockImages?: boolean } } | undefined {
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
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: {
      inMemory: (settings: { images?: { blockImages?: boolean } }) => {
        capturedSettings = settings
        return {}
      },
    },
    createAgentSession: async (options: { noTools?: 'builtin'; customTools?: Array<{ name: string }> }) => {
      capturedSessionOptions = options
      sessionActivated = true
      const listeners: Array<(event: MockPiEvent) => void> = []
      const state: { messages: unknown[] } = { messages: [] }
      return {
        session: {
          state,
          agent: { toolExecution: 'parallel' },
          subscribe(listener: (event: MockPiEvent) => void) {
            listeners.push(listener)
            return () => {}
          },
          async prompt() {
            await promptGate
            promptCallCount += 1
            const events = promptEventBatches.shift() ?? promptEvents
            for (const event of events) {
              if (event.type === 'message_end' && event.message) state.messages.push(event.message)
              for (const listener of listeners) listener(event)
            }
            for (const listener of listeners) listener({ type: 'agent_end', messages: [] })
          },
          async abort() { abortCallCount += 1 },
          dispose() { disposeCallCount += 1 },
        },
      }
    },
  }),
}))

mock.module('./pi-model-registry', () => ({
  registerPiModelFromChannel: async () => ({
    agentDir: '/tmp/pi-agent',
    modelRuntime: {},
    model: {},
  }),
}))

const { PiAgentAdapter } = await import('./pi-agent-adapter')

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

  test('given Pi starts a session when P0 tools are configured then Pi built-ins are disabled and only the Proma bridge is enabled', async () => {
    capturedSessionOptions = undefined
    capturedSettings = undefined
    capturedSystemPromptOverride = undefined
    promptGate = undefined
    promptEvents = []
    promptEventBatches = []
    promptCallCount = 0
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
    expect(getCapturedSettings()?.images?.blockImages).toBe(false)
    expect(getCapturedSystemPrompt()).toContain('使用 WebSearch 或 WebFetch')
    expect(getCapturedSystemPrompt()).toContain('征求同意')
    expect(getCapturedSystemPrompt()).toContain('绝不能先调用 WebBridgeScreenshot')
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
