import { describe, expect, test } from 'bun:test'
import type { LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'
import { AISDKStreamPartConverter, consumeAISDKStream, createAgentAISDKModel } from './ai-sdk-bridge.ts'
import type { StreamEvent } from './types.ts'

interface ModelProbe {
  provider: string
  modelId: string
  config?: {
    baseURL?: string
  }
}

function usage(): LanguageModelUsage {
  return {
    inputTokens: 12,
    inputTokenDetails: {
      noCacheTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    },
    outputTokens: 5,
    outputTokenDetails: {
      textTokens: 5,
      reasoningTokens: 0,
    },
    totalTokens: 17,
  }
}

async function* parts(items: TextStreamPart<ToolSet>[]): AsyncIterable<TextStreamPart<ToolSet>> {
  yield* items
}

describe('AI SDK bridge', () => {
  test('given supported Agent protocols then provider-specific AI SDK models are created', () => {
    const anthropic = createAgentAISDKModel({
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'key',
      modelId: 'claude-test',
    }) as unknown as ModelProbe
    const google = createAgentAISDKModel({
      provider: 'google',
      protocol: 'google-generative',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'key',
      modelId: 'gemini-test',
    }) as unknown as ModelProbe
    const openai = createAgentAISDKModel({
      provider: 'openai',
      protocol: 'openai-chat',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      modelId: 'gpt-test',
    }) as unknown as ModelProbe

    expect(anthropic.provider).toBe('proma-anthropic')
    expect(anthropic.modelId).toBe('claude-test')
    expect(google.provider).toBe('proma-google')
    expect(google.config?.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(openai.provider).toBe('proma-openai-compatible.chat')
  })

  test('given text and reasoning stream parts then Proma stream events are emitted', () => {
    const converter = new AISDKStreamPartConverter()

    expect(converter.convert({ type: 'text-delta', id: 'text-1', text: '你好' })).toEqual([
      { type: 'chunk', delta: '你好' },
    ])
    expect(converter.convert({ type: 'reasoning-start', id: 'reasoning-1' })).toEqual([
      { type: 'reasoning_block_start' },
    ])
    expect(converter.convert({ type: 'reasoning-delta', id: 'reasoning-1', text: '分析中' })).toEqual([
      { type: 'reasoning', delta: '分析中' },
    ])
    expect(converter.convert({ type: 'reasoning-end', id: 'reasoning-1' })).toEqual([
      { type: 'reasoning_block_stop' },
    ])
  })

  test('given incremental tool input then duplicate final tool-call start is suppressed', () => {
    const converter = new AISDKStreamPartConverter()

    expect(converter.convert({ type: 'tool-input-start', id: 'call-1', toolName: 'read_file' })).toEqual([
      { type: 'tool_call_start', toolCallId: 'call-1', toolName: 'read_file' },
    ])
    expect(converter.convert({ type: 'tool-input-delta', id: 'call-1', delta: '{"path":' })).toEqual([
      { type: 'tool_call_delta', toolCallId: 'call-1', argumentsDelta: '{"path":' },
    ])
    expect(converter.convert({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'read_file',
      input: { path: 'README.md' },
      dynamic: true,
    })).toEqual([
      { type: 'tool_call_delta', toolCallId: 'call-1', argumentsDelta: '{"path":"README.md"}' },
    ])
  })

  test('given finish and error parts then terminal events are emitted', async () => {
    const events: StreamEvent[] = []

    await consumeAISDKStream(parts([
      { type: 'finish', finishReason: 'tool-calls', rawFinishReason: 'tool_calls', totalUsage: usage() },
      { type: 'error', error: new Error('boom') },
    ]), (event) => events.push(event))

    expect(events).toEqual([
      {
        type: 'usage',
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 0,
        },
      },
      { type: 'done', stopReason: 'tool_use' },
      { type: 'error', error: 'boom' },
    ])
  })
})
