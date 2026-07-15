/**
 * Provider-Agnostic Agent 适配器集成测试
 *
 * 使用 mock 模拟 @proma/core 的 SSE 流，验证 DeepSeek 路由下
 * Agent 能够完成"读取文件 → 编辑文件 → 返回结果"的完整循环。
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter, ProviderRequest, StreamSSEResult, ToolCall } from '@proma/core'
import type { SDKMessage, SDKResultMessage } from '@proma/shared'

// 被测模块依赖 attachment-service/document-parser，它们会加载 electron，
// 因此在测试环境中先 mock electron。
mock.module('electron', () => ({
  BrowserWindow: class MockBrowserWindow {},
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  },
}))

// 附件富化依赖真实文件系统，在集成测试中 mock 为可控行为
mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  readAttachmentAsBase64: (localPath: string) => `base64:${localPath}`,
}))
mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async (localPath: string) => `文档内容：${localPath}`,
}))

// 被测模块需要在 mock 之后导入
const { ProviderAgnosticAgentAdapter } = await import('./provider-agnostic-agent-adapter')

/** 从 mock 请求体中提取的轻量视图 */
interface CapturedRequest {
  userMessage: string
  historyLength: number
  continuationCount: number
  attachmentCount?: number
}

describe('Provider-Agnostic Agent 适配器', () => {
  let tempDir: string
  let streamCallCount = 0
  let capturedRequests: CapturedRequest[] = []

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-paa-adapter-test-'))
    streamCallCount = 0
    capturedRequests = []

    // mock @proma/core，用回合制逻辑替代真实 SSE 请求
    mock.module('@proma/core', () => ({
      getAdapter: (_provider: string): ProviderAdapter => ({
        providerType: 'deepseek',
        buildStreamRequest: (input): ProviderRequest => {
          const body = JSON.parse(
            JSON.stringify({
              model: input.modelId,
              system: input.systemMessage,
              history: input.history,
              userMessage: input.userMessage,
              continuationMessages: input.continuationMessages,
            }),
          )
          capturedRequests.push({
            userMessage: body.userMessage,
            historyLength: (body.history ?? []).length,
            continuationCount: (body.continuationMessages ?? []).length,
          })
          return {
            url: 'http://localhost/mock',
            headers: { Authorization: 'Bearer mock' },
            body: JSON.stringify(body),
          }
        },
        parseSSELine: () => [],
        buildTitleRequest: () => ({ url: '', headers: {}, body: '' }),
        parseTitleResponse: () => null,
      }),
      streamSSE: async (): Promise<StreamSSEResult> => {
        streamCallCount++
        if (streamCallCount === 1) {
          return makeStreamResult('我来读取文件内容', [
            { id: 'tc_1', name: 'Read', arguments: { file_path: 'note.txt' } },
          ])
        }
        if (streamCallCount === 2) {
          return makeStreamResult('现在修改文件', [
            { id: 'tc_2', name: 'Edit', arguments: { file_path: 'note.txt', old_string: 'old', new_string: 'new' } },
          ])
        }
        return makeStreamResult('文件编辑完成，任务结束')
      },
    }))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    mock.restore()
  })

  test('完整工具循环：读取并编辑文件', async () => {
    writeFileSync(join(tempDir, 'note.txt'), 'old content', 'utf-8')

    const adapter = new ProviderAgnosticAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const msg of adapter.query({
      sessionId: 's1',
      prompt: '把 note.txt 里的 old 改成 new',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
      permissionMode: 'bypassPermissions',
    })) {
      messages.push(msg)
    }

    // 验证文件确实被编辑
    expect(readFileSync(join(tempDir, 'note.txt'), 'utf-8')).toBe('new content')

    // 验证共产生 6 条消息：
    // 1. assistant 读取文件
    // 2. user tool_result 读取结果
    // 3. assistant 编辑文件
    // 4. user tool_result 编辑结果
    // 5. assistant 最终回复
    // 6. result success
    expect(messages).toHaveLength(6)

    const assistantMsgs = messages.filter((m) => m.type === 'assistant')
    expect(assistantMsgs).toHaveLength(3)

    const toolResultMsgs = messages.filter((m) => m.type === 'user')
    expect(toolResultMsgs).toHaveLength(2)

    const resultMsg = messages.find((m): m is SDKResultMessage => m.type === 'result')
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.subtype).toBe('success')

    // 验证 streamSSE 被调用了 3 次
    expect(streamCallCount).toBe(3)

    // 验证请求体结构：userMessage 始终为原始 prompt，续接消息逐轮累积
    expect(capturedRequests).toHaveLength(3)
    expect(capturedRequests[0]?.userMessage).toBe('把 note.txt 里的 old 改成 new')
    expect(capturedRequests[1]?.userMessage).toBe('把 note.txt 里的 old 改成 new')
    expect(capturedRequests[2]?.userMessage).toBe('把 note.txt 里的 old 改成 new')
    expect(capturedRequests[0]?.historyLength).toBe(0)
    expect(capturedRequests[1]?.historyLength).toBe(0)
    expect(capturedRequests[2]?.historyLength).toBe(0)
    expect(capturedRequests[0]?.continuationCount).toBe(0)
    expect(capturedRequests[1]?.continuationCount).toBe(2) // assistant tool_use + user tool_result
    expect(capturedRequests[2]?.continuationCount).toBe(4) // 两轮 tool_use + tool_result
  })

  test('非 bypassPermissions 模式下写工具会被拒绝', async () => {
    writeFileSync(join(tempDir, 'note.txt'), 'old content', 'utf-8')

    const adapter = new ProviderAgnosticAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const msg of adapter.query({
      sessionId: 's1',
      prompt: '把 note.txt 里的 old 改成 new',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
      // 未提供 permissionMode，默认走本地兜底：写工具拒绝
    })) {
      messages.push(msg)
    }

    // 文件不应被修改
    expect(readFileSync(join(tempDir, 'note.txt'), 'utf-8')).toBe('old content')

    // 应产生 assistant + user tool_result（拒绝） + result
    expect(messages.length).toBeGreaterThanOrEqual(2)
    const resultMsg = messages.find((m): m is SDKResultMessage => m.type === 'result')
    expect(resultMsg).toBeDefined()
    expect(resultMsg?.subtype).toBe('success')
  })

  test('无工具调用时直接结束', async () => {
    mock.module('@proma/core', () => ({
      getAdapter: (_provider: string): ProviderAdapter => ({
        providerType: 'deepseek',
        buildStreamRequest: (input): ProviderRequest => ({
          url: 'http://localhost/mock',
          headers: {},
          body: JSON.stringify({ userMessage: input.userMessage }),
        }),
        parseSSELine: () => [],
        buildTitleRequest: () => ({ url: '', headers: {}, body: '' }),
        parseTitleResponse: () => null,
      }),
      streamSSE: async (): Promise<StreamSSEResult> => makeStreamResult('不需要工具'),
    }))

    const adapter = new ProviderAgnosticAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const msg of adapter.query({
      sessionId: 's2',
      prompt: '你好',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
    })) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(2)
    expect(messages[0]?.type).toBe('assistant')
    expect(messages[1]?.type).toBe('result')
  })

  test('附件会进入 buildStreamRequest', async () => {
    mock.module('@proma/core', () => ({
      getAdapter: (_provider: string): ProviderAdapter => ({
        providerType: 'deepseek',
        buildStreamRequest: (input): ProviderRequest => {
          capturedRequests.push({
            userMessage: input.userMessage,
            historyLength: (input.history ?? []).length,
            continuationCount: (input.continuationMessages ?? []).length,
            attachmentCount: (input.attachments ?? []).length,
          })
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
      streamSSE: async (): Promise<StreamSSEResult> => makeStreamResult('收到附件'),
    }))

    const adapter = new ProviderAgnosticAgentAdapter()

    for await (const _msg of adapter.query({
      sessionId: 's3-attach',
      prompt: '总结附件',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
      attachments: [
        { id: 'img', filename: 'screenshot.png', mediaType: 'image/png', size: 100, localPath: 's1/screenshot.png' },
        { id: 'doc', filename: 'note.txt', mediaType: 'text/plain', size: 100, localPath: 's1/note.txt' },
      ],
    })) {
      // no-op
    }

    expect(capturedRequests).toHaveLength(1)
    expect(capturedRequests[0]?.userMessage).toContain('总结附件')
    expect(capturedRequests[0]?.userMessage).toContain('<file name="note.txt">')
    expect(capturedRequests[0]?.userMessage).toContain('文档内容：s1/note.txt')
    expect(capturedRequests[0]?.attachmentCount).toBe(1)
  })

  test('历史消息会传入 buildStreamRequest', async () => {
    mock.module('@proma/core', () => ({
      getAdapter: (_provider: string): ProviderAdapter => ({
        providerType: 'deepseek',
        buildStreamRequest: (input): ProviderRequest => {
          capturedRequests.push({
            userMessage: input.userMessage,
            historyLength: (input.history ?? []).length,
            continuationCount: (input.continuationMessages ?? []).length,
          })
          return {
            url: 'http://localhost/mock',
            headers: {},
            body: JSON.stringify({ historyLength: (input.history ?? []).length }),
          }
        },
        parseSSELine: () => [],
        buildTitleRequest: () => ({ url: '', headers: {}, body: '' }),
        parseTitleResponse: () => null,
      }),
      streamSSE: async (): Promise<StreamSSEResult> => makeStreamResult('收到历史'),
    }))

    const adapter = new ProviderAgnosticAgentAdapter()
    const history: SDKMessage[] = [
      { type: 'user', message: { content: [{ type: 'text', text: '之前的问题' }] }, parent_tool_use_id: null } as SDKMessage,
      { type: 'assistant', message: { content: [{ type: 'text', text: '之前的回答' }] }, parent_tool_use_id: null } as SDKMessage,
    ]

    for await (const _msg of adapter.query({
      sessionId: 's3',
      prompt: '新问题',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
      historyMessages: history,
    })) {
      // no-op
    }

    expect(capturedRequests).toHaveLength(1)
    expect(capturedRequests[0]?.historyLength).toBe(2)
    expect(capturedRequests[0]?.userMessage).toBe('新问题')
  })

  test('streamSSE 瞬时错误会重试', async () => {
    let attempts = 0
    mock.module('@proma/core', () => ({
      getAdapter: (_provider: string): ProviderAdapter => ({
        providerType: 'deepseek',
        buildStreamRequest: (input): ProviderRequest => ({
          url: 'http://localhost/mock',
          headers: {},
          body: JSON.stringify({ userMessage: input.userMessage }),
        }),
        parseSSELine: () => [],
        buildTitleRequest: () => ({ url: '', headers: {}, body: '' }),
        parseTitleResponse: () => null,
      }),
      streamSSE: async (): Promise<StreamSSEResult> => {
        attempts++
        if (attempts === 1) {
          throw new Error('fetch failed: socket hang up')
        }
        return makeStreamResult('重试成功')
      },
    }))

    const adapter = new ProviderAgnosticAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const msg of adapter.query({
      sessionId: 's4',
      prompt: '重试测试',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: 'mock-key',
      baseUrl: 'http://localhost/mock',
      cwd: tempDir,
      maxRetries: 2,
    })) {
      messages.push(msg)
    }

    expect(attempts).toBe(2)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.type).toBe('assistant')
  })
})

function makeStreamResult(content: string, toolCalls: ToolCall[] = []): StreamSSEResult {
  return {
    content,
    reasoning: '',
    thinkingBlocks: [],
    toolCalls,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  }
}
