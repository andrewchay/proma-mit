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

// 被测模块需要在 mock 之后导入
const { ProviderAgnosticAgentAdapter } = await import('./provider-agnostic-agent-adapter')

describe('Provider-Agnostic Agent 适配器', () => {
  let tempDir: string
  let streamCallCount = 0

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-paa-adapter-test-'))
    streamCallCount = 0

    // mock @proma/core，用回合制逻辑替代真实 SSE 请求
    mock.module('@proma/core', () => ({
      getAdapter: (_provider: string): ProviderAdapter => ({
        providerType: 'deepseek',
        buildStreamRequest: (input): ProviderRequest => ({
          url: 'http://localhost/mock',
          headers: { Authorization: 'Bearer mock' },
          body: JSON.stringify({
            model: input.modelId,
            system: input.systemMessage,
            history: input.history,
            userMessage: input.userMessage,
            continuationMessages: input.continuationMessages,
          }),
        }),
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
