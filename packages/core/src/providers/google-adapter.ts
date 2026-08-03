/**
 * Google Generative AI 供应商适配器
 *
 * 实现 Google Generative AI (Gemini) API 的消息转换、请求构建和 SSE 解析。
 * 特点：
 * - 角色：user / model（注意：assistant 映射为 model）
 * - 图片格式：{ inlineData: { mimeType, data } }
 * - SSE 解析：遍历 candidates[0].content.parts，区分 thought 推理和正常文本 + functionCall
 * - 认证：API Key 作为 URL 查询参数
 * - 支持推理内容：Gemini 2.5/3 系列通过 thinkingConfig 启用思考过程回显
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  StreamRequestInput,
  StreamEvent,
  TitleRequestInput,
  ImageAttachmentData,
  ToolDefinition,
  ContinuationMessage,
} from './types.ts'
import { normalizeBaseUrl } from './url-utils.ts'

// ===== Google 特有类型 =====

/** Google 内容部分（扩展支持 functionCall / functionResponse） */
interface GooglePart {
  text?: string
  /** Gemini 2.5/3 思考内容标记 */
  thought?: boolean
  /** 思考签名（工具调用时由模型生成，续接请求必须原样返回） */
  thoughtSignature?: string
  inlineData?: {
    mimeType: string
    data: string
    displayName?: string
  }
  functionCall?: {
    name: string
    args?: Record<string, unknown>
  }
  functionResponse?: {
    name: string
    response: Record<string, unknown>
    parts?: GooglePart[]
  }
}

/** Google 消息内容 */
interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

/** Google SSE 流式响应 */
interface GoogleStreamData {
  candidates?: Array<{
    content?: {
      parts?: GooglePart[]
    }
    finishReason?: string
  }>
}

/** Google 标题响应 */
interface GoogleTitleResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
    }
  }>
}

// ===== 消息转换 =====

/**
 * 将图片附件转换为 Google 格式的内容部分
 */
function buildImageParts(imageData: ImageAttachmentData[]): GooglePart[] {
  return imageData.map((img) => ({
    inlineData: {
      mimeType: img.mediaType,
      data: img.data,
    },
  }))
}

/** Gemini 3 系列支持在 functionResponse 内原生回传多模态结果。 */
function supportsMultimodalFunctionResponse(modelId: string): boolean {
  return /^gemini-3(?:[.-]|$)/i.test(modelId)
}

function screenshotDisplayName(toolCallId: string, index: number, mediaType: string): string {
  const extension = mediaType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
  const safeToolCallId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `tool-${safeToolCallId}-${index}.${extension}`
}

/**
 * 构建包含图片和文本的消息部分列表
 */
function buildMessageParts(text: string, imageData: ImageAttachmentData[]): GooglePart[] {
  const parts: GooglePart[] = buildImageParts(imageData)
  if (text) {
    parts.push({ text })
  }
  return parts
}

/**
 * 将统一消息历史转换为 Google 格式
 *
 * Google API 的 assistant 角色为 model，不支持 system 消息角色
 * （system 通过 body.systemInstruction 传递）。
 * 包含历史消息附件的处理。
 */
function toGoogleContents(input: StreamRequestInput): GoogleContent[] {
  const { history, userMessage, attachments, readImageAttachments } = input

  // 历史消息转换
  const contents: GoogleContent[] = history
    .filter((msg) => msg.role !== 'system')
    .map((msg) => {
      const role = msg.role === 'assistant' ? 'model' as const : 'user' as const

      // 历史用户消息的附件也需要转换为多模态内容
      if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
        const historyImages = readImageAttachments(msg.attachments)
        return { role, parts: buildMessageParts(msg.content, historyImages) }
      }

      // Gemini 思考模型要求历史消息中包含 thought 标记的推理部分
      if (msg.role === 'assistant' && msg.reasoning) {
        return {
          role,
          parts: [
            { text: msg.reasoning, thought: true },
            { text: msg.content },
          ],
        }
      }

      return { role, parts: [{ text: msg.content }] }
    })

  // 当前用户消息
  const currentImages = readImageAttachments(attachments)
  contents.push({
    role: 'user',
    parts: buildMessageParts(userMessage, currentImages),
  })

  return contents
}

/**
 * 将工具定义转换为 Google 格式
 */
function toGoogleTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return [{
    functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }]
}

/**
 * 将续接消息追加到 Google contents 列表
 */
function appendContinuationMessages(
  contents: GoogleContent[],
  continuationMessages: ContinuationMessage[],
  modelId: string,
): void {
  for (const contMsg of continuationMessages) {
    if (contMsg.role === 'assistant') {
      const parts: GooglePart[] = []
      if (contMsg.content) {
        parts.push({ text: contMsg.content })
      }
      for (const tc of contMsg.toolCalls) {
        const part: GooglePart = {
          functionCall: { name: tc.name, args: tc.arguments },
        }
        // 还原 thoughtSignature（Gemini 2.5+ 思考模型要求原样返回）
        if (tc.metadata?.thoughtSignature) {
          part.thoughtSignature = tc.metadata.thoughtSignature as string
        }
        parts.push(part)
      }
      contents.push({ role: 'model', parts })
    } else if (contMsg.role === 'tool') {
      const parts: GooglePart[] = []
      const supportsNativeImageResult = supportsMultimodalFunctionResponse(modelId)

      for (const result of contMsg.results) {
        const images = result.imageData ?? []
        const imageParts = images.map((image, index): GooglePart => ({
          inlineData: {
            mimeType: image.mediaType,
            data: image.data,
            displayName: screenshotDisplayName(result.toolCallId, index, image.mediaType),
          },
        }))
        const response: Record<string, unknown> = { content: result.content }

        if (supportsNativeImageResult && imageParts.length > 0) {
          response.screenshots = imageParts.map((part) => ({
            $ref: part.inlineData?.displayName,
          }))
        }

        parts.push({
          functionResponse: {
            name: result.toolCallId,
            response,
            ...(supportsNativeImageResult && imageParts.length > 0 ? { parts: imageParts } : {}),
          },
        })

        // Gemini 2.5 及更早版本不支持 functionResponse 内的二进制数据；
        // 在同一 user turn 紧随 functionResponse 回传图片，保持视觉上下文可用。
        if (!supportsNativeImageResult) parts.push(...imageParts)
      }
      contents.push({ role: 'user', parts })
    }
  }
}

// ===== 适配器实现 =====

export class GoogleAdapter implements ProviderAdapter {
  readonly providerType = 'google' as const

  /** Google SSE 流以流自然结束为终止，无 [DONE] 哨兵 */
  readonly requiresTerminator = false

  buildStreamRequest(input: StreamRequestInput): ProviderRequest {
    const url = normalizeBaseUrl(input.baseUrl)
    const contents = toGoogleContents(input)

    // 构建 generationConfig
    const generationConfig: Record<string, unknown> = {}

    // 思考模式配置：
    // - 启用时：显示思考过程 + 设置 thinkingBudget 控制深度
    // - 关闭时：不传 thinkingConfig，模型使用默认行为
    if (input.thinkingEnabled) {
      generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: 16384,
      }
    }

    const body: Record<string, unknown> = {
      contents,
    }

    // 仅在有配置时才添加 generationConfig
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig
    }

    if (input.systemMessage) {
      body.systemInstruction = {
        parts: [{ text: input.systemMessage }],
      }
    }

    // 工具定义
    if (input.tools && input.tools.length > 0) {
      body.tools = toGoogleTools(input.tools)
    }

    // 工具续接消息
    if (input.continuationMessages && input.continuationMessages.length > 0) {
      appendContinuationMessages(contents, input.continuationMessages, input.modelId)
    }

    return {
      url: `${url}/v1beta/models/${input.modelId}:streamGenerateContent?alt=sse&key=${input.apiKey}`,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  }

  parseSSELine(jsonLine: string): StreamEvent[] {
    try {
      const parsed = JSON.parse(jsonLine) as GoogleStreamData
      const parts = parsed.candidates?.[0]?.content?.parts
      if (!parts) return []

      const events: StreamEvent[] = []

      // 遍历所有 parts，区分推理内容、正常文本和函数调用
      for (const part of parts) {
        // 函数调用（Google 一次返回完整参数）
        if (part.functionCall) {
          const fc = part.functionCall
          events.push({
            type: 'tool_call_start',
            toolCallId: fc.name,  // Google 没有独立的调用 ID，用函数名
            toolName: fc.name,
            // 保留 thoughtSignature，续接请求需要原样返回
            metadata: part.thoughtSignature
              ? { thoughtSignature: part.thoughtSignature }
              : undefined,
          })
          events.push({
            type: 'tool_call_delta',
            toolCallId: fc.name,
            argumentsDelta: JSON.stringify(fc.args || {}),
          })
          continue
        }

        if (!part.text) continue

        if (part.thought) {
          // Gemini 2.5/3 思考过程
          events.push({ type: 'reasoning', delta: part.text })
        } else {
          // 正常回复内容
          events.push({ type: 'chunk', delta: part.text })
        }
      }

      return events
    } catch {
      return []
    }
  }

  buildTitleRequest(input: TitleRequestInput): ProviderRequest {
    const url = normalizeBaseUrl(input.baseUrl)

    return {
      url: `${url}/v1beta/models/${input.modelId}:generateContent?key=${input.apiKey}`,
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
        generationConfig: { maxOutputTokens: 50 },
      }),
    }
  }

  parseTitleResponse(responseBody: unknown): string | null {
    const data = responseBody as GoogleTitleResponse
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null
  }
}
