/**
 * MA 工具 LLM 服务
 *
 * 复用 MAPro 的 Provider 适配器和渠道配置，为 MA Chat Tools 提供非流式 LLM 调用能力。
 *
 * 设计原则：
 * - 复用用户已配置的渠道（channel）和 API Key
 * - 优先使用 OpenAI 兼容协议（覆盖大多数 provider）
 * - 支持 Anthropic Messages API 作为 fallback
 * - 支持 json_mode（通过 response_format 或 prompt 注入）
 */

import { listChannels, decryptApiKey } from '../../channel-manager'
import { getFetchFn } from '../../proxy-fetch'
import { getEffectiveProxyUrl } from '../../proxy-settings-service'
import type { ProviderType } from '@gravitas/shared'

// =====================================================================
// 类型定义
// =====================================================================

export interface LLMTextPart {
  type: 'text'
  text: string
}

export interface LLMImagePart {
  type: 'image_url'
  image_url: { url: string }
}

export type LLMContentPart = LLMTextPart | LLMImagePart

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LLMContentPart[]
}

export interface LLMCompleteOptions {
  /** 系统提示词 */
  systemPrompt?: string
  /** 是否要求 JSON 输出 */
  jsonMode?: boolean
  /** 温度 */
  temperature?: number
  /** 最大 token 数 */
  maxTokens?: number
  /** 指定使用的模型 ID（默认取渠道默认模型） */
  modelId?: string
  /** 指定 provider 类型（默认自动选择第一个可用渠道） */
  provider?: ProviderType
}

export interface LLMCompleteResult {
  /** 模型生成的文本 */
  text: string
  /** 是否成功 */
  success: boolean
  /** 错误信息（失败时） */
  error?: string
  /** 使用的渠道信息 */
  channelInfo?: { id: string; name: string; provider: ProviderType; modelId: string }
}

/** 提取文本内容（用于 system prompt 等场景） */
function extractTextFromContent(content: string | LLMContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((part): part is LLMTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/** 解析 data URL，返回 mime type 和 base64 数据 */
function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mediaType: match[1]!, data: match[2]! }
}

/** 转换为 OpenAI 兼容格式 */
function convertContentToOpenAI(content: string | LLMContentPart[]): string | unknown[] {
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    return { type: 'image_url', image_url: { url: part.image_url.url } }
  })
}

/** 转换为 Anthropic 兼容格式 */
function convertContentToAnthropic(content: string | LLMContentPart[]): string | unknown[] {
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text }
    }
    const parsed = parseDataUrl(part.image_url.url)
    if (!parsed) {
      // fallback：当作 text 说明
      return { type: 'text', text: `[image: ${part.image_url.url}]` }
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    }
  })
}

/** 转换为 Google Gemini 兼容格式 */
function convertContentToGoogle(content: string | LLMContentPart[], role: string): unknown[] {
  if (typeof content === 'string') {
    return [{ text: `[${role}] ${content}` }]
  }
  return content.map((part) => {
    if (part.type === 'text') {
      return { text: `[${role}] ${part.text}` }
    }
    const parsed = parseDataUrl(part.image_url.url)
    if (!parsed) {
      return { text: `[image: ${part.image_url.url}]` }
    }
    return {
      inline_data: {
        mime_type: parsed.mediaType,
        data: parsed.data,
      },
    }
  })
}

// =====================================================================
// Provider 协议分类
// =====================================================================

/** OpenAI 兼容协议的 provider */
const OPENAI_COMPATIBLE_PROVIDERS: ProviderType[] = [
  'openai', 'deepseek', 'zhipu', 'doubao', 'qwen', 'custom',
]

/** Anthropic 兼容协议的 provider */
const ANTHROPIC_COMPATIBLE_PROVIDERS: ProviderType[] = [
  'anthropic', 'kimi-api', 'kimi-coding', 'minimax',
]

/** 不支持非流式直接调用的 provider（需要特殊处理） */
const UNSUPPORTED_PROVIDERS: ProviderType[] = ['google']

// =====================================================================
// 核心完成函数
// =====================================================================

/**
 * 非流式 LLM 调用
 *
 * 自动寻找用户配置的第一个可用渠道，发送非流式请求并返回文本结果。
 *
 * @param messages 消息列表（最后一条应为 user 消息）
 * @param options 调用选项
 * @returns 完成结果
 */
export async function complete(
  messages: LLMMessage[],
  options: LLMCompleteOptions = {},
): Promise<LLMCompleteResult> {
  const channel = findAvailableChannel(options.provider)
  if (!channel) {
    return {
      text: '',
      success: false,
      error: '未找到可用的 AI 渠道，请先配置渠道（设置 → 渠道管理）',
    }
  }

  let apiKey: string
  try {
    apiKey = decryptApiKey(channel.id)
  } catch {
    return {
      text: '',
      success: false,
      error: '解密 API Key 失败',
    }
  }

  const modelId = options.modelId || channel.models.find((m) => m.enabled)?.id || 'gpt-4o'
  const proxyUrl = await getEffectiveProxyUrl()
  const fetchFn = getFetchFn(proxyUrl)

  try {
    if (OPENAI_COMPATIBLE_PROVIDERS.includes(channel.provider)) {
      return await completeOpenAICompatible(channel.baseUrl, apiKey, modelId, messages, options, fetchFn)
    }

    if (ANTHROPIC_COMPATIBLE_PROVIDERS.includes(channel.provider)) {
      return await completeAnthropicCompatible(channel.baseUrl, apiKey, modelId, messages, options, fetchFn)
    }

    if (channel.provider === 'google') {
      return await completeGoogle(channel.baseUrl, apiKey, modelId, messages, options, fetchFn)
    }

    return {
      text: '',
      success: false,
      error: `不支持的 provider 类型: ${channel.provider}`,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[MA LLM服务] 调用失败:', error)
    return { text: '', success: false, error: msg }
  }
}

/**
 * 简化的单 prompt 调用
 *
 * @param prompt 用户提示词
 * @param systemPrompt 系统提示词
 * @param options 其他选项
 */
export async function completePrompt(
  prompt: string,
  systemPrompt?: string,
  options?: Omit<LLMCompleteOptions, 'systemPrompt'>,
): Promise<LLMCompleteResult> {
  const messages: LLMMessage[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({ role: 'user', content: prompt })
  return complete(messages, options)
}

// =====================================================================
// OpenAI 兼容协议调用
// =====================================================================

async function completeOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: LLMMessage[],
  options: LLMCompleteOptions,
  fetchFn: typeof fetch,
): Promise<LLMCompleteResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`

  const body: Record<string, unknown> = {
    model: modelId,
    messages: messages.map((m) => ({ role: m.role, content: convertContentToOpenAI(m.content) })),
    temperature: options.temperature ?? 0.7,
    stream: false,
  }

  if (options.maxTokens) {
    body.max_tokens = options.maxTokens
  }

  if (options.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    return {
      text: '',
      success: false,
      error: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}`,
    }
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string }; text?: string }>
    error?: { message?: string }
  }

  if (data.error?.message) {
    return { text: '', success: false, error: data.error.message }
  }

  const text = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? ''
  return { text, success: true }
}

// =====================================================================
// Anthropic 兼容协议调用
// =====================================================================

async function completeAnthropicCompatible(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: LLMMessage[],
  options: LLMCompleteOptions,
  fetchFn: typeof fetch,
): Promise<LLMCompleteResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/messages`

  // 分离 system 消息
  const systemContent =
    options.systemPrompt ?? extractTextFromContent(messages.find((m) => m.role === 'system')?.content ?? '')
  const chatMessages = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: convertContentToAnthropic(m.content),
  }))

  const body: Record<string, unknown> = {
    model: modelId,
    messages: chatMessages,
    max_tokens: options.maxTokens ?? 4000,
    temperature: options.temperature ?? 0.7,
    stream: false,
  }

  if (systemContent) {
    body.system = systemContent
  }

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    return {
      text: '',
      success: false,
      error: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}`,
    }
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>
    error?: { message?: string }
  }

  if (data.error?.message) {
    return { text: '', success: false, error: data.error.message }
  }

  const text = data.content?.find((c) => c.type === 'text')?.text ?? ''
  return { text, success: true }
}

// =====================================================================
// Google Gemini 调用
// =====================================================================

async function completeGoogle(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: LLMMessage[],
  options: LLMCompleteOptions,
  fetchFn: typeof fetch,
): Promise<LLMCompleteResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/models/${modelId}:generateContent?key=${apiKey}`

  // 合并 system 和 user
  const parts = messages.flatMap((m) => convertContentToGoogle(m.content, m.role))

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4000,
    },
  }

  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const errorText = await response.text()
    return {
      text: '',
      success: false,
      error: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}`,
    }
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    error?: { message?: string }
  }

  if (data.error?.message) {
    return { text: '', success: false, error: data.error.message }
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  return { text, success: true }
}

// =====================================================================
// 渠道查找
// =====================================================================

function findAvailableChannel(preferredProvider?: ProviderType) {
  const channels = listChannels()

  if (preferredProvider) {
    const match = channels.find((c) => c.provider === preferredProvider)
    if (match) return match
  }

  // 优先 OpenAI 兼容渠道（最通用）
  for (const provider of OPENAI_COMPATIBLE_PROVIDERS) {
    const match = channels.find((c) => c.provider === provider)
    if (match) return match
  }

  // 其次 Anthropic 兼容
  for (const provider of ANTHROPIC_COMPATIBLE_PROVIDERS) {
    const match = channels.find((c) => c.provider === provider)
    if (match) return match
  }

  // 最后 Google
  const google = channels.find((c) => c.provider === 'google')
  if (google) return google

  return undefined
}

// =====================================================================
// JSON 解析辅助
// =====================================================================

/**
 * 从 LLM 响应文本中提取 JSON
 */
export function extractJSON(text: string): unknown {
  const trimmed = text.trim()

  // 直接是 JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // 继续尝试提取
    }
  }

  // Markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]!.trim())
    } catch {
      // 继续
    }
  }

  // 查找第一个 { 和最后一个 }
  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1))
    } catch {
      // 继续
    }
  }

  // 查找第一个 [ 和最后一个 ]
  const arrayStart = trimmed.indexOf('[')
  const arrayEnd = trimmed.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1))
    } catch {
      // 继续
    }
  }

  throw new Error('无法从响应中提取有效 JSON')
}
