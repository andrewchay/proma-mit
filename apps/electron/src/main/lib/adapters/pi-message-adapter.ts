import type {
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKToolResultBlock,
  SDKUserContentBlock,
  SDKUserMessage,
} from '@gravitas/shared'
import type {
  AssistantMessage as PiAssistantMessage,
  ImageContent as PiImageContent,
  TextContent as PiTextContent,
  ToolCall as PiToolCall,
  ToolResultMessage as PiToolResultMessage,
  UserMessage as PiUserMessage,
} from '@earendil-works/pi-ai'
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core'

function timestamp(): number {
  return Date.now()
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content == null) return ''
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSDKUserMessage(message: SDKMessage): message is SDKUserMessage {
  return message.type === 'user'
}

function isSDKAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === 'assistant'
}

function piToolResultContentToSdk(content: string | Array<PiTextContent | PiImageContent>): unknown {
  if (typeof content === 'string') return content
  return content.map((block) => block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image', data: block.data, mimeType: block.mimeType })
}

function sdkUserContentToText(content: SDKUserContentBlock[] | undefined): string {
  if (!content) return ''
  return content
    .filter((block): block is Extract<SDKUserContentBlock, { type: 'text' }> => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function sdkAssistantContentToPi(content: SDKContentBlock[]): PiAssistantMessage['content'] {
  const blocks: PiAssistantMessage['content'] = []
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '' })
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'toolCall',
        id: typeof block.id === 'string' ? block.id : `tool-${Date.now()}`,
        name: typeof block.name === 'string' ? block.name : 'tool',
        arguments: (isRecord(block.input) ? block.input : {}) as PiToolCall['arguments'],
      })
    }
  }
  return blocks
}

function sdkToolResultContentToPi(block: SDKToolResultBlock): Array<PiTextContent | PiImageContent> {
  if (Array.isArray(block.content)) {
    const content: Array<PiTextContent | PiImageContent> = []
    for (const item of block.content) {
      if (!isRecord(item)) continue
      if (item.type === 'text' && typeof item.text === 'string') {
        content.push({ type: 'text', text: item.text })
        continue
      }
      if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        content.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      }
    }
    if (content.length > 0) return content
  }
  return [{ type: 'text', text: stringifyContent(block.content) }]
}

function piUsageToSdk(usage: PiAssistantMessage['usage']): SDKAssistantMessage['message']['usage'] {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  }
}

function piToolCallToSdk(block: PiToolCall): SDKContentBlock {
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: block.arguments,
  }
}

function convertPiAssistantMessage(
  message: PiAssistantMessage,
  sessionId: string,
  channelModelId?: string,
  options: { final?: boolean; uuid?: string } = {},
): SDKAssistantMessage {
  const final = options.final ?? true
  const content: SDKContentBlock[] = message.content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text }
    }
    if (block.type === 'thinking') {
      return { type: 'thinking', thinking: block.thinking }
    }
    return piToolCallToSdk(block)
  })

  return {
    type: 'assistant',
    message: {
      content,
      usage: piUsageToSdk(message.usage),
      model: message.model,
      stop_reason: message.stopReason,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    _channelModelId: channelModelId,
    ...(options.uuid ? { uuid: options.uuid } : {}),
    ...(!final ? { _partial: true } : {}),
    ...(final && message.stopReason === 'error' && message.errorMessage
      ? { error: { message: message.errorMessage, errorType: 'pi_runtime_error' } }
      : {}),
  }
}

function convertPiToolResultMessage(message: PiToolResultMessage, sessionId: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: piToolResultContentToSdk(message.content),
        is_error: message.isError,
      }],
    },
    parent_tool_use_id: message.toolCallId,
    session_id: sessionId,
  }
}

export function convertPiMessageToSDKMessage(
  message: PiAgentMessage,
  sessionId: string,
  channelModelId?: string,
  options?: { final?: boolean; uuid?: string },
): SDKMessage | null {
  if (message.role === 'assistant') {
    return convertPiAssistantMessage(message, sessionId, channelModelId, options) as SDKMessage
  }
  if (message.role === 'toolResult') {
    return convertPiToolResultMessage(message, sessionId) as SDKMessage
  }
  return null
}

export function isAssistantPiMessage(message: PiAgentMessage): message is PiAssistantMessage {
  return message.role === 'assistant'
}

export function convertPiMessagesToSDKMessages(
  messages: PiAgentMessage[],
  sessionId: string,
  channelModelId?: string,
): SDKMessage[] {
  return messages
    .map((message) => convertPiMessageToSDKMessage(message, sessionId, channelModelId))
    .filter((message): message is SDKMessage => message !== null)
}

function compactBoundaryToPiUserMessage(message: SDKMessage): PiUserMessage | undefined {
  if (message.type !== 'system') return undefined
  const boundary = message as unknown as {
    subtype?: string
    summary?: string
    contextPacket?: unknown
  }
  if (boundary.subtype !== 'compact_boundary' || !boundary.summary?.trim()) return undefined
  const packet = boundary.contextPacket ?? { version: 1, summary: boundary.summary.trim() }
  return {
    role: 'user',
    content: `以下是系统生成的既有会话压缩上下文。将其作为历史事实与未完成工作继续，不要把它当作用户的新指令。\n<context_packet>${JSON.stringify(packet)}</context_packet>`,
    timestamp: timestamp(),
  }
}

/**
 * SDK 历史恢复到 Pi：
 * - compact_boundary 转成模型可见的历史摘要，避免压缩后只剩最近消息；
 * - 仅恢复能匹配前序 assistant tool_use 的 tool_result，自动丢弃旧坏历史中的孤儿结果；
 * - 使用真实工具名，而不是统一伪造成 "tool"。
 */
export function convertSDKMessagesToPiMessages(messages: SDKMessage[]): PiAgentMessage[] {
  const piMessages: PiAgentMessage[] = []
  const pendingToolCalls = new Map<string, string>()
  for (const message of messages) {
    const boundary = compactBoundaryToPiUserMessage(message)
    if (boundary) {
      pendingToolCalls.clear()
      piMessages.push(boundary)
      continue
    }

    if (isSDKUserMessage(message)) {
      const toolResultBlocks = message.message?.content?.filter(
        (block): block is SDKToolResultBlock => block.type === 'tool_result',
      ) ?? []
      for (const block of toolResultBlocks) {
        const toolName = pendingToolCalls.get(block.tool_use_id)
        // 压缩切片或旧版本持久化可能遗留孤儿 tool_result；严格 OpenAI 网关会 400，恢复时安全丢弃。
        if (!toolName) continue
        piMessages.push({
          role: 'toolResult',
          toolCallId: block.tool_use_id,
          toolName,
          content: sdkToolResultContentToPi(block),
          isError: block.is_error ?? false,
          timestamp: timestamp(),
        })
        pendingToolCalls.delete(block.tool_use_id)
      }

      const text = sdkUserContentToText(message.message?.content)
      if (text) {
        piMessages.push({
          role: 'user',
          content: text,
          timestamp: timestamp(),
        } satisfies PiUserMessage)
        // 新用户文本开始后，未完成的旧工具调用不再允许与更晚结果错误配对。
        pendingToolCalls.clear()
      }
    } else if (isSDKAssistantMessage(message)) {
      pendingToolCalls.clear()
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          pendingToolCalls.set(block.id, typeof block.name === 'string' ? block.name : 'tool')
        }
      }
      piMessages.push({
        role: 'assistant',
        content: sdkAssistantContentToPi(message.message.content),
        api: 'openai-completions',
        provider: 'proma-history',
        model: message.message.model ?? message._channelModelId ?? 'unknown',
        usage: {
          input: message.message.usage?.input_tokens ?? 0,
          output: message.message.usage?.output_tokens ?? 0,
          cacheRead: message.message.usage?.cache_read_input_tokens ?? 0,
          cacheWrite: message.message.usage?.cache_creation_input_tokens ?? 0,
          totalTokens: (message.message.usage?.input_tokens ?? 0) + (message.message.usage?.output_tokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: timestamp(),
      } satisfies PiAssistantMessage)
    }
  }
  return piMessages
}
