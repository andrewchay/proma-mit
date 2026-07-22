import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { LanguageModelUsage } from 'ai'
import type { AgentEvent, SDKMessage } from '@proma/shared'
import type { RuntimeMcpService } from '../agent-runtime/runtime-mcp-service'
import type { McpClientManager } from '../agent-runtime/mcp-client'

interface CapturedStreamTextInput {
  model: unknown
  system: string
  messages: Array<{ role: string; content: string }>
  tools: Record<string, {
    execute?: (input: Record<string, unknown>, options: { toolCallId: string; messages: unknown[]; abortSignal?: AbortSignal; context: Record<string, never> }) => Promise<unknown>
  }>
  stopWhen: unknown
  abortSignal?: AbortSignal
}

let capturedInputs: CapturedStreamTextInput[] = []
let streamTextMode: 'text' | 'streamed-text' | 'stream-error-after-text' | 'write-tool' | 'queued-text' = 'text'
let releaseQueuedStream: (() => void) | undefined

function usage(): LanguageModelUsage {
  return {
    inputTokens: 10,
    inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 4,
    outputTokenDetails: { textTokens: 4, reasoningTokens: 0 },
    totalTokens: 14,
  }
}

mock.module('electron', () => ({
  BrowserWindow: class MockBrowserWindow {},
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
  saveAttachment: () => ({
    id: 'attachment-1',
    name: 'mock.txt',
    mediaType: 'text/plain',
    size: 4,
    localPath: '/tmp/mock.txt',
    createdAt: Date.now(),
  }),
  readAttachmentAsBase64: (localPath: string) => `base64:${localPath}`,
  deleteAttachment: () => {},
  deleteConversationAttachments: () => {},
}))

mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async (localPath: string) => `文档内容：${localPath}`,
}))

mock.module('@proma/core/providers/ai-sdk-bridge', () => ({
  AISDKStreamStepAccumulator: class MockAISDKStreamStepAccumulator {
    private text = ''

    consume(part: { type: string; text?: string; finishReason?: string }): Array<{
      text: string
      toolCalls: never[]
      toolResults: never[]
      finishReason: string
    }> {
      if (part.type === 'text-delta') {
        this.text += part.text ?? ''
        return []
      }
      if (part.type === 'finish-step') {
        return [{
          text: this.text,
          toolCalls: [],
          toolResults: [],
          finishReason: part.finishReason ?? 'stop',
        }]
      }
      return []
    }
  },
  createAgentAISDKModel: (input: Record<string, unknown>) => ({
    provider: 'mock-ai-sdk',
    input,
  }),
}))

mock.module('ai', () => ({
  isStepCount: (count: number) => ({ type: 'step-count', count }),
  jsonSchema: (schema: unknown) => schema,
  tool: (definition: unknown) => definition,
  streamText: (input: CapturedStreamTextInput) => {
    capturedInputs.push(input)
    const stream = (async function* () {
      if (streamTextMode === 'queued-text') {
        if (capturedInputs.length === 1) {
          await new Promise<void>((resolve, reject) => {
            releaseQueuedStream = resolve
            input.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
        }
        yield { type: 'text-delta', id: `text-${capturedInputs.length}`, text: `AI SDK 第 ${capturedInputs.length} 轮回复` }
        yield { type: 'finish-step', finishReason: 'stop', rawFinishReason: 'stop', usage: usage() }
      }
      if (streamTextMode === 'streamed-text') {
        yield { type: 'text-delta', id: 'text-1', text: 'AI SDK 流式回复' }
        yield { type: 'finish-step', finishReason: 'stop', rawFinishReason: 'stop', usage: usage() }
      }
      if (streamTextMode === 'stream-error-after-text') {
        yield { type: 'text-delta', id: 'text-1', text: '半截回复' }
        throw new Error('fetch failed: socket hang up')
      }
      if (streamTextMode === 'write-tool') {
        const output = await input.tools.Write?.execute?.(
          { file_path: 'note.txt', content: 'new' },
          { toolCallId: 'tc-write', messages: [], abortSignal: input.abortSignal, context: {} },
        )
        yield { type: 'tool-result', output }
      }
    })()

    const steps = (async () => {
      if (streamTextMode === 'write-tool') {
        const output = await input.tools.Write?.execute?.(
          { file_path: 'note.txt', content: 'new' },
          { toolCallId: 'tc-write', messages: [], abortSignal: input.abortSignal, context: {} },
        )
        return [{
          text: '',
          reasoningText: undefined,
          toolCalls: [{
            toolCallId: 'tc-write',
            toolName: 'Write',
            input: { file_path: 'note.txt', content: 'new' },
          }],
          toolResults: [{
            toolCallId: 'tc-write',
            toolName: 'Write',
            input: { file_path: 'note.txt', content: 'new' },
            output,
          }],
          finishReason: 'tool-calls',
          usage: usage(),
        }]
      }
      return [{
        text: 'AI SDK 回复',
        reasoningText: undefined,
        toolCalls: [],
        toolResults: [],
        finishReason: 'stop',
        usage: usage(),
      }]
    })()

    return {
      stream,
      get steps() {
        if (streamTextMode === 'streamed-text') {
          throw new Error('streamed step path should not await result.steps')
        }
        return steps
      },
      usage: Promise.resolve(usage()),
    }
  },
}))

const { AISDKAgentAdapter } = await import('./ai-sdk-agent-adapter')

describe('AISDKAgentAdapter', () => {
  beforeEach(() => {
    capturedInputs = []
    streamTextMode = 'text'
    releaseQueuedStream = undefined
  })

  test('缺少必要渠道字段时返回清晰错误', async () => {
    const adapter = new AISDKAgentAdapter()

    await expect(async () => {
      for await (const _message of adapter.query({ sessionId: 's-ai', prompt: 'hi', agentRuntime: 'ai-sdk' })) {
        // 配置不完整，不应产出消息。
      }
    }).toThrow('AI SDK Runtime 需要 provider、apiKey、baseUrl、model、cwd')
  })

  test('OpenAI-compatible provider 会通过 AI SDK 生成消息', async () => {
    const adapter = new AISDKAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const message of adapter.query({
      sessionId: 's-ai',
      prompt: 'hello',
      agentRuntime: 'ai-sdk',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      cwd: '/tmp',
    })) {
      messages.push(message)
    }

    expect(capturedInputs).toHaveLength(1)
    expect(capturedInputs[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'hello' })
    expect(messages.map((message) => message.type)).toEqual(['assistant', 'result'])
  })

  test('配置 MCP 时通过 runtime MCP service 加载工具并在结束后释放', async () => {
    const release = mock(() => {})
    const listAllTools = mock(async () => [{
      name: 'mcp__fs__read_file',
      description: '读取文件',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: 'ok' }),
    }])
    const mcpService: RuntimeMcpService = {
      acquireClientManager: mock(async () => ({
        manager: { listAllTools } as unknown as McpClientManager,
        release,
      })),
    }
    const adapter = new AISDKAgentAdapter(mcpService)

    for await (const _message of adapter.query({
      sessionId: 's-mcp',
      prompt: 'hello',
      agentRuntime: 'ai-sdk',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      cwd: '/tmp',
      workspaceSlug: 'workspace-a',
      mcpServers: { fs: { type: 'stdio', enabled: true, command: 'node', args: [] } },
    })) {
      // 消费完整迭代器，确保 finally 释放 MCP lease。
    }

    expect(mcpService.acquireClientManager).toHaveBeenCalledTimes(1)
    expect(listAllTools).toHaveBeenCalledTimes(1)
    expect(Object.keys(capturedInputs[0]?.tools ?? {})).toContain('mcp__fs__read_file')
    expect(release).toHaveBeenCalledTimes(1)
  })

  test('Anthropic provider 会通过 AI SDK 生成消息', async () => {
    const adapter = new AISDKAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const message of adapter.query({
      sessionId: 's-anthropic',
      prompt: 'hello',
      agentRuntime: 'ai-sdk',
      provider: 'anthropic',
      apiKey: 'key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
      cwd: '/tmp',
    })) {
      messages.push(message)
    }

    expect(capturedInputs).toHaveLength(1)
    expect(JSON.stringify(capturedInputs[0]?.model)).toContain('anthropic-messages')
    expect(messages.map((message) => message.type)).toEqual(['assistant', 'result'])
  })

  test('Google provider 会通过 AI SDK 生成消息', async () => {
    const adapter = new AISDKAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const message of adapter.query({
      sessionId: 's-google',
      prompt: 'hello',
      agentRuntime: 'ai-sdk',
      provider: 'google',
      apiKey: 'key',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-test',
      cwd: '/tmp',
    })) {
      messages.push(message)
    }

    expect(capturedInputs).toHaveLength(1)
    expect(JSON.stringify(capturedInputs[0]?.model)).toContain('google-generative')
    expect(messages.map((message) => message.type)).toEqual(['assistant', 'result'])
  })

  test('AI SDK stream step 足够完整时直接从 stream 构建 SDKMessage', async () => {
    streamTextMode = 'streamed-text'
    const adapter = new AISDKAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const message of adapter.query({
      sessionId: 's-streamed',
      prompt: 'hello',
      agentRuntime: 'ai-sdk',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      cwd: '/tmp',
    })) {
      messages.push(message)
    }

    expect(messages.map((message) => message.type)).toEqual(['assistant', 'result'])
    expect(JSON.stringify(messages[0])).toContain('AI SDK 流式回复')
  })

  test('AI SDK stream part 会实时上报 AgentEvent', async () => {
    streamTextMode = 'streamed-text'
    const adapter = new AISDKAgentAdapter()
    const events: AgentEvent[] = []

    for await (const _message of adapter.query({
      sessionId: 's-events',
      prompt: 'hello',
      agentRuntime: 'ai-sdk',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      cwd: '/tmp',
      onAgentEvent: (event) => events.push(event),
    })) {
      // 消费完整迭代器，触发 stream 消费和最终 SDKMessage 生成。
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'AI SDK 流式回复' },
      {
        type: 'usage_update',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
    ])
  })

  test('AI SDK stream 已上报实时事件后遇到瞬时错误不会自动重试以免重复渲染', async () => {
    streamTextMode = 'stream-error-after-text'
    const adapter = new AISDKAgentAdapter()
    const events: AgentEvent[] = []

    await expect(async () => {
      for await (const _message of adapter.query({
        sessionId: 's-stream-error',
        prompt: 'hello',
        agentRuntime: 'ai-sdk',
        provider: 'openai',
        apiKey: 'key',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
        cwd: '/tmp',
        maxRetries: 2,
        onAgentEvent: (event) => events.push(event),
      })) {
        // stream 中途失败，不应产出完整消息。
      }
    }).toThrow('fetch failed: socket hang up')

    expect(capturedInputs).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'text_delta', text: '半截回复' })
    expect(events[1]).toMatchObject({
      type: 'typed_error',
      error: {
        code: 'network_error',
        canRetry: true,
      },
    })
  })

  test('当前未声明 AI SDK 支持的 provider 会被拒绝', async () => {
    const adapter = new AISDKAgentAdapter()

    await expect(async () => {
      for await (const _message of adapter.query({
        sessionId: 's-minimax',
        prompt: 'hello',
        agentRuntime: 'ai-sdk',
        provider: 'minimax',
        apiKey: 'key',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        model: 'minimax-test',
        cwd: '/tmp',
      })) {
        // 当前未声明支持，不应产出消息。
      }
    }).toThrow('AI SDK Runtime 暂不支持 minimax')
  })

  test('safe 模式会拒绝写工具执行', async () => {
    streamTextMode = 'write-tool'
    const adapter = new AISDKAgentAdapter()
    const messages: SDKMessage[] = []

    for await (const message of adapter.query({
      sessionId: 's-safe',
      prompt: 'write file',
      agentRuntime: 'ai-sdk',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      cwd: '/tmp',
      permissionMode: 'safe',
    })) {
      messages.push(message)
    }

    const toolResultMessage = messages.find((message) => message.type === 'user')
    expect(JSON.stringify(toolResultMessage)).toContain('安全模式下不允许执行写操作')
  })

  test('given a message queued with interruption when the active turn stops then it runs as the next turn with prior context', async () => {
    streamTextMode = 'queued-text'
    const adapter = new AISDKAgentAdapter()
    const iterator = adapter.query({
      sessionId: 's-queue',
      prompt: '先回答第一个问题',
      agentRuntime: 'ai-sdk',
      provider: 'openai',
      apiKey: 'key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      cwd: '/tmp',
    })

    const stream = iterator[Symbol.asyncIterator]()
    const firstMessage = stream.next()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await adapter.interruptQuery('s-queue')
    await adapter.sendQueuedMessage('s-queue', {
      type: 'user',
      message: { role: 'user', content: '继续回答第二个问题' },
      parent_tool_use_id: null,
      session_id: 's-queue',
      uuid: 'queued-1',
    })

    const first = await firstMessage
    const messages: SDKMessage[] = first.value ? [first.value] : []
    while (true) {
      const next = await stream.next()
      if (next.done) break
      messages.push(next.value)
    }

    expect(capturedInputs).toHaveLength(2)
    expect(capturedInputs[1]?.messages.map((message) => message.content)).toEqual([
      '先回答第一个问题',
      '继续回答第二个问题',
    ])
    expect(messages.map((message) => message.type)).toEqual(['assistant', 'result'])
  })
})
