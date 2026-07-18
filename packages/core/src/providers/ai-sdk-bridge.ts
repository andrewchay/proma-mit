/**
 * Vercel AI SDK 兼容桥接层。
 *
 * 这层只做模型工厂和事件协议转换，不接管 Proma 当前的 Agent 工具循环。
 * 后续如果要迁移到 Web/Server runtime，可以在这里继续扩展 provider 与工具映射。
 */

import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel, LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'
import { streamText } from 'ai'
import type { StreamEvent, StreamEventCallback } from './types.ts'
import { normalizeBaseUrl } from './url-utils.ts'

export interface AISDKOpenAICompatibleModelInput {
  /** OpenAI-compatible API Base URL，通常包含 /v1 或兼容路径 */
  baseUrl: string
  /** 明文 API Key */
  apiKey: string
  /** 模型 ID */
  modelId: string
  /** AI SDK provider 名称，用于日志/metadata 区分第三方 OpenAI-compatible provider */
  providerName?: string
  /** 额外请求头 */
  headers?: Record<string, string>
}

export interface AISDKStreamTextBridgeInput {
  model: LanguageModel
  prompt: string
  system?: string
  abortSignal?: AbortSignal
  onEvent: StreamEventCallback
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function toToolArgumentsDelta(input: unknown): string {
  if (input === undefined) return ''
  if (typeof input === 'string') return input
  return JSON.stringify(input)
}

function toUsageEvent(usage: LanguageModelUsage): StreamEvent {
  return {
    type: 'usage',
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens,
      cache_creation_input_tokens: usage.inputTokenDetails.cacheWriteTokens,
    },
  }
}

function toDoneStopReason(finishReason: string): string {
  if (finishReason === 'stop') return 'end_turn'
  if (finishReason === 'tool-calls') return 'tool_use'
  return finishReason
}

/** 创建 OpenAI Chat Completions 兼容的 AI SDK 模型实例。 */
export function createOpenAICompatibleAISDKModel(input: AISDKOpenAICompatibleModelInput): LanguageModel {
  const provider = createOpenAI({
    apiKey: input.apiKey,
    baseURL: normalizeBaseUrl(input.baseUrl),
    name: input.providerName ?? 'proma-openai-compatible',
    headers: input.headers,
  })

  return provider.chat(input.modelId)
}

/**
 * 有状态的 AI SDK stream part 转换器。
 *
 * AI SDK 可能同时发 tool-input-* 增量和最终 tool-call 事件；转换器记录已开始的
 * toolCallId，避免下游重复创建同一个工具调用。
 */
export class AISDKStreamPartConverter {
  private readonly startedToolCallIds = new Set<string>()

  convert(part: TextStreamPart<ToolSet>): StreamEvent[] {
    switch (part.type) {
      case 'text-delta':
        return [{ type: 'chunk', delta: part.text }]
      case 'reasoning-start':
        return [{ type: 'reasoning_block_start' }]
      case 'reasoning-delta':
        return [{ type: 'reasoning', delta: part.text }]
      case 'reasoning-end':
        return [{ type: 'reasoning_block_stop' }]
      case 'tool-input-start':
        this.startedToolCallIds.add(part.id)
        return [{ type: 'tool_call_start', toolCallId: part.id, toolName: part.toolName }]
      case 'tool-input-delta':
        return [{ type: 'tool_call_delta', toolCallId: part.id, argumentsDelta: part.delta }]
      case 'tool-call': {
        const events: StreamEvent[] = []
        if (!this.startedToolCallIds.has(part.toolCallId)) {
          this.startedToolCallIds.add(part.toolCallId)
          events.push({ type: 'tool_call_start', toolCallId: part.toolCallId, toolName: part.toolName })
        }

        const argumentsDelta = toToolArgumentsDelta(part.input)
        if (argumentsDelta) {
          events.push({ type: 'tool_call_delta', toolCallId: part.toolCallId, argumentsDelta })
        }
        return events
      }
      case 'finish':
        return [
          toUsageEvent(part.totalUsage),
          { type: 'done', stopReason: toDoneStopReason(part.finishReason) },
        ]
      case 'error':
        return [{ type: 'error', error: formatUnknownError(part.error) }]
      case 'abort':
        return [{ type: 'error', error: part.reason ?? 'AI SDK stream aborted' }]
      case 'tool-error':
        return [{ type: 'error', error: formatUnknownError(part.error) }]
      default:
        return []
    }
  }
}

/** 消费 AI SDK stream，并把事件转发为 Proma core 的 StreamEvent。 */
export async function consumeAISDKStream(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  onEvent: StreamEventCallback,
): Promise<void> {
  const converter = new AISDKStreamPartConverter()
  for await (const part of stream) {
    for (const event of converter.convert(part)) {
      onEvent(event)
    }
  }
}

/**
 * 最小化的 streamText 桥接入口。
 *
 * 当前只用于 future Web/Server runtime spike；生产 Agent runtime 仍走现有 Proma 工具循环。
 */
export async function streamTextToPromaEvents(input: AISDKStreamTextBridgeInput): Promise<void> {
  const result = streamText({
    model: input.model,
    prompt: input.prompt,
    system: input.system,
    abortSignal: input.abortSignal,
  })

  await consumeAISDKStream(result.stream, input.onEvent)
}
