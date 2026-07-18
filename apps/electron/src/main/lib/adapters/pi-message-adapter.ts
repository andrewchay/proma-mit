import type {
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKToolResultBlock,
  SDKUserContentBlock,
  SDKUserMessage,
} from '@proma/shared'
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

function piContentToText(content: string | Array<PiTextContent | PiImageContent>): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is PiTextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
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

function sdkToolResultContentToPi(block: SDKToolResultBlock): PiTextContent[] {
  const content = stringifyContent(block.content)
  return [{ type: 'text', text: content }]
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
): SDKAssistantMessage {
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
    ...(message.errorMessage ? { error: { message: message.errorMessage, errorType: 'pi_runtime_error' } } : {}),
  }
}

function convertPiToolResultMessage(message: PiToolResultMessage, sessionId: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: piContentToText(message.content),
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
): SDKMessage | null {
  if (message.role === 'assistant') {
    return convertPiAssistantMessage(message, sessionId, channelModelId) as SDKMessage
  }
  if (message.role === 'toolResult') {
    return convertPiToolResultMessage(message, sessionId) as SDKMessage
  }
  return null
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

export function convertSDKMessagesToPiMessages(messages: SDKMessage[]): PiAgentMessage[] {
  const piMessages: PiAgentMessage[] = []
  for (const message of messages) {
    if (isSDKUserMessage(message)) {
      const toolResultBlocks = message.message?.content?.filter(
        (block): block is SDKToolResultBlock => block.type === 'tool_result',
      ) ?? []
      for (const block of toolResultBlocks) {
        piMessages.push({
          role: 'toolResult',
          toolCallId: block.tool_use_id,
          toolName: 'tool',
          content: sdkToolResultContentToPi(block),
          isError: block.is_error ?? false,
          timestamp: timestamp(),
        })
      }

      const text = sdkUserContentToText(message.message?.content)
      if (text) {
        piMessages.push({
          role: 'user',
          content: text,
          timestamp: timestamp(),
        } satisfies PiUserMessage)
      }
    } else if (isSDKAssistantMessage(message)) {
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
