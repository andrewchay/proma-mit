/**
 * Pi Agent 适配器：流式期间用户追加输入
 *
 * 验证 sendQueuedMessage 的 steer/followUp 路由与 interrupt 软中断。
 * 独立 mock pi-sdk-loader，避免与既有 Pi 测试相互干扰。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'

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
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
}))
mock.module('../attachment-service', () => ({
  isImageAttachment: () => false,
  readAttachmentAsBase64: () => 'base64:mock',
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
  saveAttachment: async () => ({ path: '/tmp/mock', fileName: 'mock.png', mimeType: 'image/png', size: 1 }),
}))
mock.module('../document-parser', () => ({
  isDocumentAttachment: () => false,
  extractTextFromAttachment: async () => '',
}))

// mock session 状态
let steerCalls: string[] = []
let followUpCalls: string[] = []
let abortCalls = 0
let streaming = false
let promptGate: Promise<void> | undefined
let resolvePrompt: (() => void) | undefined
let capturedSessionOptions: { noTools?: 'builtin'; customTools?: Array<{ name: string }> } | undefined

mock.module('./pi-sdk-loader', () => ({
  loadPiCodingAgent: async () => ({
    DefaultResourceLoader: class {
      constructor() {}
      async reload(): Promise<void> {}
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    createAgentSession: async (options: { noTools?: 'builtin'; customTools?: Array<{ name: string }> }) => {
      capturedSessionOptions = options
      return {
        session: {
          state: { messages: [] },
          agent: { toolExecution: 'parallel' },
          subscribe: () => () => {},
          async prompt() {
            await promptGate
          },
          get isStreaming() {
            return streaming
          },
          async steer(text: string) {
            steerCalls.push(text)
          },
          async followUp(text: string) {
            followUpCalls.push(text)
          },
          async abort() {
            abortCalls += 1
          },
          dispose() {},
        },
      }
    },
  }),
}))

mock.module('./pi-model-registry', () => ({
  registerPiModelFromChannel: async () => ({
    agentDir: '/tmp/pi-agent',
    modelRuntime: {},
    providerId: 'proma-test',
    model: { contextWindow: 200_000 },
  }),
}))

const { PiAgentAdapter } = await import('./pi-agent-adapter')
type PiAgentAdapterInstance = InstanceType<typeof PiAgentAdapter>

function startQuery(adapter: PiAgentAdapterInstance): AsyncIterator<unknown> {
  const stream = adapter.query({
    sessionId: 's-pi-queue',
    prompt: '第一问',
    agentRuntime: 'pi',
    provider: 'deepseek',
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    model: 'test-model',
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    canUseTool: async () => ({ allowed: true }),
  })
  const iterator = stream[Symbol.asyncIterator]()
  // 触发 query 执行（async generator 惰性；执行到 queue.next 挂起）
  void iterator.next()
  return iterator
}

describe('Pi 流式追加', () => {
  beforeEach(() => {
    steerCalls = []
    followUpCalls = []
    abortCalls = 0
    streaming = false
    capturedSessionOptions = undefined
    promptGate = new Promise<void>((resolve) => { resolvePrompt = resolve })
  })

  afterEach(() => {
    mock.restore()
    resolvePrompt?.()
  })

  test('priority=now 时走 session.steer', async () => {
    streaming = true
    const adapter = new PiAgentAdapter()
    const iterator = startQuery(adapter)
    await new Promise((r) => setTimeout(r, 20))

    await adapter.sendQueuedMessage('s-pi-queue', {
      type: 'user',
      message: { role: 'user', content: '打断问题' },
      parent_tool_use_id: null,
      priority: 'now',
      session_id: 's-pi-queue',
    })

    expect(steerCalls).toEqual(['打断问题'])
    expect(followUpCalls).toEqual([])

    resolvePrompt?.()
    await iterator.return?.()
  })

  test('普通追加走 session.followUp', async () => {
    streaming = true
    const adapter = new PiAgentAdapter()
    const iterator = startQuery(adapter)
    await new Promise((r) => setTimeout(r, 20))

    await adapter.sendQueuedMessage('s-pi-queue', {
      type: 'user',
      message: { role: 'user', content: '排队问题' },
      parent_tool_use_id: null,
      session_id: 's-pi-queue',
    })

    expect(followUpCalls).toEqual(['排队问题'])
    expect(steerCalls).toEqual([])

    resolvePrompt?.()
    await iterator.return?.()
  })

  test('interrupt 时调用 session.abort 并等待 prompt 链重发', async () => {
    streaming = true
    const adapter = new PiAgentAdapter()
    const iterator = startQuery(adapter)
    await new Promise((r) => setTimeout(r, 20))

    const accepted = new Promise<void>((resolve) => {
      adapter.sendQueuedMessage('s-pi-queue', {
        type: 'user',
        message: { role: 'user', content: '打断重发' },
        parent_tool_use_id: null,
        session_id: 's-pi-queue',
      }, { interrupt: true }).then(() => resolve())
    })

    // 等 abort 被调用
    await new Promise((r) => setTimeout(r, 20))
    expect(abortCalls).toBeGreaterThanOrEqual(1)

    // 释放 prompt 链：prompt resolve 后应消费 pendingInterruptPrompts 重发
    resolvePrompt?.()
    await new Promise((r) => setTimeout(r, 20))

    await accepted
    await iterator.return?.()
  })

  test('工具注册包含 CompactContext', async () => {
    const adapter = new PiAgentAdapter()
    const iterator = startQuery(adapter)
    await new Promise((r) => setTimeout(r, 20))
    expect(capturedSessionOptions?.customTools?.some((t) => t.name === 'CompactContext')).toBe(true)
    resolvePrompt?.()
    await iterator.return?.()
  })
})
