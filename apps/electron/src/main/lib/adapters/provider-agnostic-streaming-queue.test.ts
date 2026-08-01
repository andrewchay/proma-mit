/**
 * Provider-Agnostic Agent 适配器：流式期间用户追加输入
 *
 * 验证 query 运行中调用 sendQueuedMessage 后，追加消息会在下一轮作为用户输入处理。
 * 独立 mock @proma/core，避免与既有适配器测试相互干扰。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter, ProviderRequest, StreamSSEResult, ToolCall } from '@proma/core'
import type { SDKMessage } from '@proma/shared'

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

// 被测模块需要在 mock 之后导入
const { ProviderAgnosticAgentAdapter } = await import('./provider-agnostic-agent-adapter')

function makeStreamResult(content: string, toolCalls: ToolCall[] = []): StreamSSEResult {
  return {
    content,
    reasoning: '',
    thinkingBlocks: [],
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  }
}

describe('Provider-Agnostic 流式追加', () => {
  let tempDir: string
  let capturedUserMessages: string[] = []

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-paa-queue-test-'))
    capturedUserMessages = []

    mock.module('@proma/core', () => ({
      getAdapter: (): ProviderAdapter => ({
        providerType: 'deepseek',
        buildStreamRequest: (input): ProviderRequest => {
          capturedUserMessages.push(input.userMessage)
          return {
            url: 'http://localhost/mock',
            headers: {},
            body: JSON.stringify({ userMessage: input.userMessage }),
          }
        },
        parseSSELine: () => [],
        buildTitleRequest: () => ({ url: '', headers: {}, body: '' }),
        parseTitleResponse: () => null,
      }),
      streamSSE: async (): Promise<StreamSSEResult> => makeStreamResult('已处理'),
    }))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    mock.restore()
  })

  test('query 运行中 sendQueuedMessage 追加后，下一轮处理追加消息', async () => {
    const adapter = new ProviderAgnosticAgentAdapter()
    const stream = adapter.query({
      sessionId: 's-queue',
      prompt: '第一问',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
      permissionMode: 'bypassPermissions',
    })

    // 消费第一轮（拿到 assistant 消息，query 暂停在 yield）
    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const firstMsg = first.value as SDKMessage
    expect(firstMsg.type).toBe('assistant')
    expect(capturedUserMessages[0]).toBe('第一问')

    // 流式期间追加用户消息
    await adapter.sendQueuedMessage('s-queue', {
      type: 'user',
      message: { role: 'user', content: '追加问题' },
      parent_tool_use_id: null,
      session_id: 's-queue',
    })

    // 继续消费：第二轮应处理追加消息
    const second = await iterator.next()
    expect(second.done).toBe(false)
    expect((second.value as SDKMessage).type).toBe('assistant')
    expect(capturedUserMessages[1]).toBe('追加问题')

    // 无更多追加：得到 result 后结束
    const third = await iterator.next()
    expect(third.done).toBe(false)
    expect((third.value as SDKMessage).type).toBe('result')
    const done = await iterator.next()
    expect(done.done).toBe(true)
  })

  test('无追加时 query 正常结束（一次 query = 一轮）', async () => {
    const adapter = new ProviderAgnosticAgentAdapter()
    const messages: SDKMessage[] = []
    for await (const msg of adapter.query({
      sessionId: 's-normal',
      prompt: '普通问题',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
      permissionMode: 'bypassPermissions',
    })) {
      messages.push(msg)
    }

    expect(capturedUserMessages).toEqual(['普通问题'])
    expect(messages.filter((m) => m.type === 'assistant')).toHaveLength(1)
    expect(messages[messages.length - 1]?.type).toBe('result')
  })
})
