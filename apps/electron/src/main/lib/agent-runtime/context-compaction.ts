/**
 * Proma / AI SDK runtime 的上下文压缩（自研，借鉴上游 Pi session.compact() 语义）。
 *
 * Pi runtime 使用 Pi SDK 原生 compact；Claude 使用 SDK 原生压缩。
 * Proma / AI SDK runtime 没有 SDK 原生压缩，这里提供：
 * - 自动压缩：query 入口发现历史超过阈值时，用 LLM 摘要早期历史并保留最近消息；
 * - CompactContext 工具：手动请求压缩当前会话（立即执行，下一轮生效）。
 *
 * 压缩结果持久化为 system(compact_boundary) 摘要消息 + 最近消息，
 * 后续 query 读取历史时会自然看到摘要。
 */

import type { ProviderType, SDKMessage } from '@gravitas/shared'
import { getAdapter, streamSSE } from '@gravitas/core'
import type { StreamEvent, ToolResult } from '@gravitas/core'
import { getFetchFn } from '../proxy-fetch'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { compactSDKMessages } from '../agent-session-manager'
import type { RuntimeToolDefinition } from './types'

export const COMPACT_CONTEXT_TOOL_NAME = 'CompactContext'

/** 自动压缩触发阈值：历史消息条数超过此值 */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 40

/** 压缩时保留的最近消息条数（与 prompt-builder 的 MAX_HISTORY_MESSAGES 对齐） */
export const DEFAULT_KEEP_RECENT_MESSAGES = 20

/** 早期历史转文本的最小字符数；太小不值得压缩 */
const MIN_SUMMARY_SOURCE_CHARS = 2_000

const SUMMARY_SYSTEM_PROMPT =
  '你是会话上下文压缩器。把历史对话压缩成简洁的长期记忆要点，保留关键事实、决定、用户偏好、未完成任务和重要细节。使用中文，使用要点列表。'

const SUMMARY_USER_PROMPT_PREFIX =
  '请将以下历史对话压缩为简洁的长期记忆要点（保留关键事实、决定、用户偏好、未完成任务与重要细节）：\n\n'

export interface ContextCompactionOptions {
  sessionId: string
  provider: ProviderType
  /** 底层 ProviderAdapter 的供应商；DeepSeek 在 Proma runtime 下使用 OpenAI adapter */
  adapterProvider?: ProviderType
  apiKey: string
  baseUrl: string
  model: string
  /** 完整历史消息（SDKMessage 格式） */
  historyMessages: SDKMessage[]
  /** 自动压缩触发阈值（历史条数） */
  autoThreshold?: number
  /** 压缩时保留的最近消息条数 */
  keepRecent?: number
  signal?: AbortSignal
}

export interface ContextCompactionResult {
  /** 是否发生了压缩 */
  compacted: boolean
  /** 摘要文本（压缩时） */
  summary?: string
  /** 压缩后的历史（含 boundary + 最近消息）；未压缩时返回原历史 */
  history: SDKMessage[]
}

/** 是否值得压缩：历史条数超过阈值，且早期文本足够大 */
export function shouldAutoCompact(
  historyMessages: SDKMessage[],
  autoThreshold = DEFAULT_AUTO_COMPACT_THRESHOLD,
  keepRecent = DEFAULT_KEEP_RECENT_MESSAGES,
): boolean {
  return historyMessages.length - keepRecent > autoThreshold
}

/** 把早期 SDKMessage 列表转换为可读文本（用于摘要输入） */
export function sdkMessagesToCompactText(messages: SDKMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    const text = extractMessageText(msg)
    if (!text) continue
    const role = msg.type === 'user' ? '用户' : msg.type === 'assistant' ? '助手' : '系统'
    parts.push(`[${role}] ${text}`)
  }
  return parts.join('\n\n')
}

function extractMessageText(msg: SDKMessage): string {
  if (msg.type === 'system') {
    return (msg as { message?: string; summary?: string }).message
      ?? (msg as { message?: string; summary?: string }).summary
      ?? ''
  }
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string; content?: unknown; name?: string; input?: unknown }
      if (b.type === 'text') return b.text ?? ''
      if (b.type === 'tool_use') return `[调用工具 ${b.name ?? ''}: ${JSON.stringify(b.input ?? {})}]`
      if (b.type === 'tool_result') {
        const c = b.content
        return `[工具结果: ${typeof c === 'string' ? c : JSON.stringify(c)?.slice(0, 500)}]`
      }
      return ''
    })
    .filter((t) => t.length > 0)
    .join('\n')
}

/**
 * 用当前渠道的 LLM 生成历史摘要。
 * 复用 @gravitas/core 的 ProviderAdapter + streamSSE（与 provider-agnostic adapter 同路径）。
 */
export async function summarizeHistory(options: ContextCompactionOptions): Promise<string> {
  const { provider, adapterProvider, apiKey, baseUrl, model, historyMessages, keepRecent = DEFAULT_KEEP_RECENT_MESSAGES, signal } = options
  const earlyCount = Math.max(0, historyMessages.length - keepRecent)
  const earlyMessages = historyMessages.slice(0, earlyCount)
  const sourceText = sdkMessagesToCompactText(earlyMessages)

  const adapter = getAdapter(adapterProvider ?? provider)
  const request = adapter.buildStreamRequest({
    providerType: provider,
    baseUrl,
    apiKey,
    modelId: model,
    history: [],
    userMessage: SUMMARY_USER_PROMPT_PREFIX + sourceText,
    systemMessage: SUMMARY_SYSTEM_PROMPT,
    readImageAttachments: () => [],
  })

  const proxyUrl = await getEffectiveProxyUrl()
  const fetchFn = getFetchFn(proxyUrl)
  let content = ''
  await streamSSE({
    request,
    adapter,
    fetchFn,
    signal,
    onEvent: (event: StreamEvent) => {
      if (event.type === 'chunk') content += event.delta
    },
  })
  return content.trim()
}

/**
 * 立即压缩当前会话：摘要早期历史 + 保留最近消息 + 持久化 boundary。
 * 返回压缩结果与新的历史。
 */
export async function compactSessionNow(options: ContextCompactionOptions): Promise<ContextCompactionResult> {
  const { sessionId, historyMessages, keepRecent = DEFAULT_KEEP_RECENT_MESSAGES, signal } = options
  const earlyCount = Math.max(0, historyMessages.length - keepRecent)
  const earlyMessages = historyMessages.slice(0, earlyCount)

  if (earlyCount <= 0) {
    return { compacted: false, history: historyMessages }
  }
  if (sdkMessagesToCompactText(earlyMessages).trim().length < MIN_SUMMARY_SOURCE_CHARS) {
    return { compacted: false, history: historyMessages }
  }

  const summary = await summarizeHistory(options)
  if (!summary) {
    return { compacted: false, history: historyMessages }
  }

  const history = compactSDKMessages(sessionId, summary, keepRecent)
  return { compacted: true, summary, history }
}

/**
 * 自动压缩入口：历史条数超过阈值时压缩。
 * 供 provider-agnostic / ai-sdk adapter 在 query 入口调用。
 */
export async function maybeAutoCompact(options: ContextCompactionOptions): Promise<ContextCompactionResult> {
  const { historyMessages, autoThreshold = DEFAULT_AUTO_COMPACT_THRESHOLD, keepRecent = DEFAULT_KEEP_RECENT_MESSAGES } = options
  if (!shouldAutoCompact(historyMessages, autoThreshold, keepRecent)) {
    return { compacted: false, history: historyMessages }
  }
  return compactSessionNow(options)
}

/**
 * CompactContext 工具定义。
 * 模型可见；真实压缩逻辑由各 adapter 在工具执行循环中拦截（需要 provider 凭据做摘要）。
 * 此 execute 为占位实现，仅满足 RuntimeToolDefinition 类型要求，正常情况下不会被调用。
 */
export function createCompactContextToolDefinition(): RuntimeToolDefinition {
  return {
    name: COMPACT_CONTEXT_TOOL_NAME,
    description:
      '压缩当前 Agent 会话的上下文：将早期历史对话摘要为长期记忆要点并保留最近内容，之后本轮继续，下一轮对话基于压缩后的摘要继续。适合长会话接近上下文上限时调用。',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
    execute: async (_input: unknown, _ctx: unknown): Promise<ToolResult> => ({
      toolCallId: '',
      content: '上下文压缩由适配器拦截处理。',
      isError: false,
    }),
  }
}
