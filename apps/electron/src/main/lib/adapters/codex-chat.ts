import { Type } from 'typebox'
import type { AssistantMessage, Context, Message, Tool, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { ChatMessage, FileAttachment } from '@gravitas/shared'
import type { ToolCall as ChatToolCall, ToolDefinition } from '@gravitas/core'
import { getImageAttachmentData } from '../agent-runtime/attachment-enrichment'
import { createCodexRuntime } from './codex-runtime'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { getFetchFn } from '../proxy-fetch'

function userContent(text: string, attachments?: FileAttachment[]): UserMessage['content'] {
  const images = getImageAttachmentData(attachments).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mediaType }))
  return images.length ? [{ type: 'text' as const, text }, ...images] : text
}

/** 从本地 Chat 记录恢复 Codex 文本历史；旧工具结果不提升为 assistant 指令。 */
export function codexChatHistory(history: ChatMessage[]): Message[] {
  return history.map((message): Message => message.role === 'user'
    ? { role: 'user', content: userContent(message.content, message.attachments), timestamp: message.createdAt }
    : {
        role: 'assistant', provider: 'openai-codex', api: 'openai-codex-responses', model: message.model ?? '',
        content: [{ type: 'text', text: message.content }],
        stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: message.createdAt,
      })
}

export function codexChatTools(tools?: ToolDefinition[]): Tool[] | undefined {
  return tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters),
  }))
}

/** 原生 Pi Codex transport；凭据始终由渠道存储读取，不将 JSON 当作 API Key。 */
export async function streamCodexChat(input: {
  channelId: string
  modelId: string
  history: ChatMessage[]
  userMessage: string
  attachments?: FileAttachment[]
  systemPrompt?: string
  tools?: ToolDefinition[]
  thinkingLevel?: string
  continuation?: Message[]
  removeTools?: boolean
  signal: AbortSignal
  onDelta: (type: 'chunk' | 'reasoning', delta: string) => void
}): Promise<{ content: string; reasoning: string; toolCalls: ChatToolCall[]; stopReason: string; message: AssistantMessage }> {
  if (input.signal.aborted) throw new Error('ChatGPT 订阅请求已中止')
  const runtime = await createCodexRuntime(input.channelId)
  const model = runtime.getModel('openai-codex', input.modelId)
  if (!model) throw new Error(`ChatGPT 订阅不支持模型 ${input.modelId}，请刷新模型列表`)
  const context: Context = {
    systemPrompt: input.systemPrompt,
    messages: [...codexChatHistory(input.history), { role: 'user', content: userContent(input.userMessage, input.attachments), timestamp: Date.now() }, ...(input.continuation ?? [])],
    tools: input.removeTools ? undefined : codexChatTools(input.tools),
  }
  const proxyUrl = await getEffectiveProxyUrl()
  // 首事件最多等 120s；每次流事件续期，网络静默时释放 Chat 队列。
  const idleController = new AbortController()
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let rejectIdle!: (error: Error) => void
  const idleFailure = new Promise<never>((_resolve, reject) => { rejectIdle = reject })
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      idleController.abort()
      rejectIdle(new Error('ChatGPT 订阅请求超时，请检查网络或代理'))
    }, 120_000)
  }
  resetIdleTimer()
  let result: AssistantMessage
  let streamedContent = ''
  let streamedReasoning = ''
  try {
    const stream = runtime.streamSimple(model, context, {
      signal: AbortSignal.any([input.signal, idleController.signal]),
      transport: 'sse',
      fetch: getFetchFn(proxyUrl),
      maxRetries: 0,
      ...(input.thinkingLevel && input.thinkingLevel !== 'off' ? { reasoning: input.thinkingLevel as 'low' | 'medium' | 'high' | 'xhigh' } : {}),
    })
    const iterator = stream[Symbol.asyncIterator]()
    while (true) {
      const next = await Promise.race([iterator.next(), idleFailure])
      if (next.done) break
      resetIdleTimer()
      const event = next.value
      if (event.type === 'text_delta') { streamedContent += event.delta; input.onDelta('chunk', event.delta) }
      if (event.type === 'thinking_delta') { streamedReasoning += event.delta; input.onDelta('reasoning', event.delta) }
    }
    result = await Promise.race([stream.result(), idleFailure])
  } catch (error) {
    if (idleTimedOut) throw new Error('ChatGPT 订阅请求超时，请检查网络或代理')
    throw error
  } finally {
    clearTimeout(idleTimer)
  }
  if (idleTimedOut) throw new Error('ChatGPT 订阅请求超时，请检查网络或代理')
  if (input.signal.aborted) throw new Error('ChatGPT 订阅请求已中止')
  if (result.stopReason === 'error' || result.stopReason === 'aborted' || result.stopReason === 'length') throw new Error(result.errorMessage ?? `ChatGPT 订阅请求未正常完成: ${result.stopReason}`)
  const content = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('')
  const reasoning = result.content.filter((item) => item.type === 'thinking').map((item) => item.thinking).join('')
  // SDK 在缺少 delta 的服务端实现中仍可返回完整 message；补齐未流出的文本。
  if (content.startsWith(streamedContent) && content.length > streamedContent.length) input.onDelta('chunk', content.slice(streamedContent.length))
  if (reasoning.startsWith(streamedReasoning) && reasoning.length > streamedReasoning.length) input.onDelta('reasoning', reasoning.slice(streamedReasoning.length))
  const toolCalls: ChatToolCall[] = result.content.filter((item) => item.type === 'toolCall').map((item) => ({ id: item.id, name: item.name, arguments: item.arguments }))
  if (toolCalls.length && result.stopReason !== 'toolUse') throw new Error(`ChatGPT 工具调用未正常完成: ${result.stopReason}`)
  if (input.removeTools && toolCalls.length) throw new Error('ChatGPT 最终回复仍包含工具调用，已拒绝执行')
  return { content, reasoning, toolCalls, stopReason: result.stopReason, message: result }
}

export function codexToolResults(results: Array<{ toolCallId: string; toolName: string; content: string; isError?: boolean }>): ToolResultMessage[] {
  return results.map((result) => ({
    role: 'toolResult', toolCallId: result.toolCallId, toolName: result.toolName,
    content: [{ type: 'text', text: result.content }], isError: !!result.isError, timestamp: Date.now(),
  }))
}
