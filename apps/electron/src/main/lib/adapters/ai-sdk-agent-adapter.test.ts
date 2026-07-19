import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { LanguageModelUsage } from 'ai'
import type { SDKMessage } from '@proma/shared'

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
let streamTextMode: 'text' | 'write-tool' = 'text'

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
  readAttachmentAsBase64: (localPath: string) => `base64:${localPath}`,
}))

mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async (localPath: string) => `文档内容：${localPath}`,
}))

mock.module('@proma/core/providers/ai-sdk-bridge', () => ({
  createOpenAICompatibleAISDKModel: (input: Record<string, unknown>) => ({
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
      steps,
      usage: Promise.resolve(usage()),
    }
  },
}))

const { AISDKAgentAdapter } = await import('./ai-sdk-agent-adapter')

describe('AISDKAgentAdapter', () => {
  beforeEach(() => {
    capturedInputs = []
    streamTextMode = 'text'
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

  test('当前未启用的非 OpenAI-compatible provider 会被拒绝', async () => {
    const adapter = new AISDKAgentAdapter()

    await expect(async () => {
      for await (const _message of adapter.query({
        sessionId: 's-google',
        prompt: 'hello',
        agentRuntime: 'ai-sdk',
        provider: 'google',
        apiKey: 'key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-test',
        cwd: '/tmp',
      })) {
        // 当前未启用 google provider 包，不应产出消息。
      }
    }).toThrow('AI SDK Runtime 暂不支持 google 的 google-generative 协议')
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
})
