/**
 * Pi Agent 适配器：断流自动重试
 *
 * 验证 runPromptChain 遇到瞬时网络/断流错误（Pi SDK 内部 retry 耗尽后抛出）
 * 时，会重新驱动同一 session.prompt 续传，而不是直接抛给上层导致断流失败。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'

mock.module('electron', () => ({
  BrowserWindow: class {},
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

let promptCalls = 0
let promptErrors: string[] = []

mock.module('./pi-sdk-loader', () => ({
  loadPiCodingAgent: async () => ({
    DefaultResourceLoader: class {
      constructor() {}
      async reload(): Promise<void> {}
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    createAgentSession: async () => ({
      session: {
        state: { messages: [] },
        agent: { toolExecution: 'parallel' },
        subscribe: (callback: (event: { type: string; message?: { role: string } }) => void) => {
          return () => {}
        },
        async prompt() {
          promptCalls += 1
          if (promptErrors.length > 0) {
            const err = promptErrors.shift()!
            throw new Error(err)
          }
        },
        get isStreaming() {
          return false
        },
        async steer() {},
        async followUp() {},
        async abort() {},
        dispose() {},
      },
    }),
  }),
}))

mock.module('./pi-model-registry', () => ({
  registerPiModelFromChannel: async () => ({
    agentDir: '/tmp/pi-agent',
    modelRuntime: {},
    providerId: 'proma-test',
    model: { contextWindow: 1_000_000 },
  }),
}))

const { PiAgentAdapter } = await import('./pi-agent-adapter')

async function runQuery(adapter: InstanceType<typeof PiAgentAdapter>, prompt: string): Promise<string[]> {
  const stream = adapter.query({
    sessionId: 's-pi-retry',
    prompt,
    agentRuntime: 'pi',
    provider: 'deepseek',
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    model: 'deepseek-v4-pro',
    cwd: '/tmp',
    permissionMode: 'bypassPermissions',
    canUseTool: async () => ({ allowed: true }),
  })
  const results: string[] = []
  for await (const msg of stream) {
    results.push((msg as { type: string }).type)
  }
  return results
}

describe('Pi 断流自动重试', () => {
  beforeEach(() => {
    promptCalls = 0
    promptErrors = []
  })

  afterEach(() => {
    mock.restore()
  })

  test('prompt 抛瞬时断流错误后自动重试同一条 prompt', async () => {
    promptErrors = ['Stream ended without finish_reason']
    const adapter = new PiAgentAdapter()
    await runQuery(adapter, '你好')
    // 第一次抛错 + 重试成功 = 2 次 prompt
    expect(promptCalls).toBe(2)
  })

  test('prompt 抛 Anthropic 断流错误后自动重试', async () => {
    promptErrors = ['Anthropic stream ended before message_stop']
    const adapter = new PiAgentAdapter()
    await runQuery(adapter, '你好')
    expect(promptCalls).toBe(2)
  })

  test('非网络错误不重试，直接抛给上层', async () => {
    promptErrors = ['invalid_api_key']
    const adapter = new PiAgentAdapter()
    await expect(runQuery(adapter, '你好')).rejects.toThrow('invalid_api_key')
    expect(promptCalls).toBe(1)
  })

  test('断流重试超过上限后抛错', async () => {
    promptErrors = ['Stream ended without finish_reason', 'Stream ended without finish_reason', 'Stream ended without finish_reason', 'Stream ended without finish_reason']
    const adapter = new PiAgentAdapter()
    await expect(runQuery(adapter, '你好')).rejects.toThrow('Stream ended without finish_reason')
    // 初始 1 次 + 3 次重试 = 4 次（MAX_PROMPT_RETRIES=3）
    expect(promptCalls).toBe(4)
  }, 15000)
})
