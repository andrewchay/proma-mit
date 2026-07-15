/**
 * Provider-Agnostic Agent 适配器
 *
 * 实现 AgentProviderAdapter 接口，不依赖 Claude Agent SDK。
 * 基于 @proma/core 的 ProviderAdapter 实现多轮工具调用循环。
 *
 * 阶段 1 能力：
 * - 支持 Read / Write / Edit / Bash / Grep 五个核心工具
 * - 通过 SSE 流式读取模型响应
 * - 将模型返回的工具调用转发给 Runtime 工具注册表执行
 * - 将结果包装为 SDKMessage 格式返回，供 Orchestrator 统一处理
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKContentBlock,
  FileAttachment,
} from '@proma/shared'
import type {
  ProviderAdapter,
  ToolCall,
  ToolResult,
  ContinuationMessage,
  StreamEvent,
  ThinkingBlock,
} from '@proma/core'
import { getAdapter, streamSSE } from '@proma/core'
import { getFetchFn } from '../proxy-fetch'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { createCoreTools } from '../agent-runtime/tool-registry'
import type { RuntimeToolDefinition } from '../agent-runtime/types'
import { buildAgentSystemPrompt, sdkMessagesToChatMessages } from '../agent-runtime/prompt-builder'
import { enrichMessageWithDocuments, enrichHistoryWithDocuments, getImageAttachmentData } from '../agent-runtime/attachment-enrichment'
import { withRetry } from '../agent-runtime/retry'
import { isTransientNetworkError } from '../error-patterns'
import { isImageAttachment } from '../attachment-service'
import type { RuntimeMessage } from '../agent-runtime/types'

/** 工具权限检查结果 */
export interface ToolPermissionResult {
  allowed: boolean
  message?: string
}

/** 工具权限检查回调 */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ToolPermissionResult>

/** Provider-Agnostic 查询选项（扩展通用输入） */
export interface ProviderAgnosticAgentQueryOptions extends AgentQueryInput {
  /** 最大工具调用轮次 */
  maxTurns?: number
  /** 系统提示词 */
  systemPrompt?: string
  /** 权限模式 */
  permissionMode?: import('@proma/shared').PromaPermissionMode
  /** 自定义权限检查回调；未提供时按 permissionMode 做本地兜底判断 */
  canUseTool?: CanUseToolCallback
  /** 历史 SDKMessage（阶段 2：多轮会话上下文） */
  historyMessages?: import('@proma/shared').SDKMessage[]
  /** 最大 LLM 请求重试次数 */
  maxRetries?: number
}

/** 活跃会话状态 */
interface ActiveSession {
  controller: AbortController
}

export class ProviderAgnosticAgentAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActiveSession>()

  /** 发起查询，返回 SDKMessage 异步迭代流 */
  async *query(input: ProviderAgnosticAgentQueryOptions): AsyncIterable<SDKMessage> {
    const {
      sessionId,
      prompt,
      model,
      provider,
      apiKey,
      baseUrl,
      cwd,
      abortSignal,
      maxTurns = 25,
      systemPrompt,
      attachments,
    } = input

    if (!provider || !apiKey || !baseUrl || !cwd) {
      throw new Error('Provider-Agnostic Runtime 需要 provider、apiKey、baseUrl、cwd')
    }

    const adapter = getAdapter(provider)
    const tools = createCoreTools()
    const toolMap = new Map(tools.map((t) => [t.name, t]))
    const effectiveSystemPrompt = buildAgentSystemPrompt(systemPrompt, cwd)

    const controller = new AbortController()
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    this.activeSessions.set(sessionId, { controller })

    // 累积本轮所有消息（用于持久化和事件流）
    const runtimeMessages: RuntimeMessage[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheCreationTokens = 0

    try {
      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)

      // 阶段 2：加载历史消息，并提取历史消息中的文档附件文本
      const rawHistory = input.historyMessages ? sdkMessagesToChatMessages(input.historyMessages) : []
      const history = await enrichHistoryWithDocuments(rawHistory)

      // 处理当前用户消息的多模态附件
      // 文档类附件提取文本后追加到 prompt；图片类附件通过 readImageAttachments 注入
      const enrichedPrompt = await enrichMessageWithDocuments(prompt, attachments)
      const currentImageAttachments = attachments?.filter((att) => isImageAttachment(att.mediaType)) ?? []

      // 初始用户消息
      const userMessage: RuntimeMessage = {
        role: 'user',
        content: enrichedPrompt,
        createdAt: Date.now(),
      }
      runtimeMessages.push(userMessage)

      // 工具续接循环
      // 关键约定：userMessage 始终为本次用户原始 prompt；
      // assistant tool_use 与 tool_result 必须放在 continuationMessages 中，
      // 否则 Anthropic 适配器会产生“user tool_result -> assistant tool_use”的乱序/重复结构。
      let continuationMessages: ContinuationMessage[] = []
      let round = 0
      const maxRetries = input.maxRetries ?? 2

      while (round < maxTurns) {
        round++

        const request = adapter.buildStreamRequest({
          baseUrl,
          apiKey,
          modelId: model || '',
          history,
          userMessage: enrichedPrompt,
          systemMessage: effectiveSystemPrompt,
          readImageAttachments: () => getImageAttachmentData(currentImageAttachments),
          attachments: currentImageAttachments,
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
          continuationMessages: continuationMessages.length > 0 ? continuationMessages : undefined,
        })

        let currentContent = ''
        let currentReasoning = ''
        let currentThinkingBlocks: ThinkingBlock[] = []
        let currentToolCalls: ToolCall[] = []

        const handleStreamEvent = (event: StreamEvent): void => {
          if (event.type === 'chunk') {
            currentContent += event.delta
          } else if (event.type === 'reasoning') {
            currentReasoning += event.delta
          } else if (event.type === 'tool_call_start') {
            // 工具调用开始，由 streamSSE 累积参数
          }
        }

        const result = await withRetry(
          () =>
            streamSSE({
              request,
              adapter,
              signal: controller.signal,
              fetchFn,
              onEvent: handleStreamEvent,
            }),
          {
            maxRetries,
            baseDelayMs: 1000,
            shouldRetry: (error) => isTransientNetworkError(getErrorMessage(error)),
            onRetry: (attempt, error, delayMs) => {
              console.warn(`[Agent Runtime] 第 ${attempt} 次重试 streamSSE（${delayMs}ms）: ${getErrorMessage(error)}`)
            },
            signal: controller.signal,
          },
        )

        currentContent = result.content
        currentReasoning = result.reasoning
        currentThinkingBlocks = result.thinkingBlocks
        currentToolCalls = result.toolCalls

        // 累积 token 用量（最佳 effort，部分 provider 不返回）
        // 注意：streamSSE 目前不返回 usage，阶段 1 先按 0 计，后续扩展

        // 构建 assistant 消息的内容块
        const assistantContentBlocks: SDKContentBlock[] = []
        if (currentContent) {
          assistantContentBlocks.push({ type: 'text', text: currentContent })
        }
        for (const tc of currentToolCalls) {
          assistantContentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          } as unknown as SDKContentBlock)
        }

        const assistantMessage: SDKAssistantMessage = {
          type: 'assistant',
          message: {
            content: assistantContentBlocks,
            model,
            stop_reason: result.stopReason,
          },
          parent_tool_use_id: null,
          session_id: sessionId,
        }
        yield assistantMessage as unknown as SDKMessage

        // 保存 assistant 消息到 runtime history
        runtimeMessages.push({
          role: 'assistant',
          content: currentContent,
          toolCalls: currentToolCalls,
          createdAt: Date.now(),
        })

        // 无工具调用或停止原因不是 tool_use，结束循环
        if (!currentToolCalls.length || result.stopReason !== 'tool_use') {
          break
        }

        // 执行工具调用（带权限检查）
        const toolResults = await this.executeToolCalls(currentToolCalls, toolMap, {
          cwd,
          sessionId,
          abortSignal: controller.signal,
          permissionMode: input.permissionMode,
          canUseTool: input.canUseTool,
        })

        // 生成 user 消息（tool_result）
        const toolResultBlocks: { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }[] =
          toolResults.map((tr) => ({
            type: 'tool_result',
            tool_use_id: tr.toolCallId,
            content: tr.content,
            is_error: tr.isError,
          }))

        const toolResultMessage: SDKUserMessage = {
          type: 'user',
          message: { content: toolResultBlocks as unknown as import('@proma/shared').SDKUserContentBlock[] },
          parent_tool_use_id: null,
          session_id: sessionId,
        }
        yield toolResultMessage as unknown as SDKMessage

        // 保存 tool 结果到 runtime history
        for (const tr of toolResults) {
          runtimeMessages.push({
            role: 'tool',
            content: tr.content,
            toolCallId: tr.toolCallId,
            isError: tr.isError,
            createdAt: Date.now(),
          })
        }

        // 构建续接消息
        continuationMessages = [
          ...continuationMessages,
          {
            role: 'assistant',
            content: currentContent,
            reasoning: currentReasoning,
            thinkingBlocks: currentThinkingBlocks,
            toolCalls: currentToolCalls,
          },
          { role: 'tool', results: toolResults },
        ]
      }

      // 结束消息
      const resultMessage: SDKResultMessage = {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cache_read_input_tokens: totalCacheReadTokens,
          cache_creation_input_tokens: totalCacheCreationTokens,
        },
        session_id: sessionId,
      }
      yield resultMessage as unknown as SDKMessage
    } finally {
      this.activeSessions.delete(sessionId)
    }
  }

  /** 中止指定会话 */
  abort(sessionId: string): void {
    const session = this.activeSessions.get(sessionId)
    if (session) {
      session.controller.abort()
      this.activeSessions.delete(sessionId)
    }
  }

  /** 释放资源 */
  dispose(): void {
    for (const [sessionId, session] of this.activeSessions) {
      session.controller.abort()
      this.activeSessions.delete(sessionId)
    }
  }

  /**
   * 检查工具调用权限
   *
   * 阶段 1 简化策略：
   * - bypassPermissions：全部放行
   * - 未提供 canUseTool 回调时：只读工具（Read/Grep）自动放行，写工具（Write/Edit/Bash）默认拒绝
   * - 提供 canUseTool 回调时：委托给回调（可接入 AgentPermissionService）
   */
  private async checkToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    ctx: {
      abortSignal?: AbortSignal
      permissionMode?: import('@proma/shared').PromaPermissionMode
      canUseTool?: CanUseToolCallback
    },
  ): Promise<ToolPermissionResult> {
    if (ctx.permissionMode === 'bypassPermissions') {
      return { allowed: true }
    }

    if (ctx.canUseTool) {
      const signal = ctx.abortSignal ?? new AbortController().signal
      return ctx.canUseTool(toolName, input, signal)
    }

    // 本地兜底：只读工具放行，其余拒绝
    const readOnlyTools = new Set(['Read', 'Grep'])
    if (readOnlyTools.has(toolName)) {
      return { allowed: true }
    }

    return {
      allowed: false,
      message: `${toolName} 需要用户授权，但当前未配置权限回调。请在设置中将权限模式设为“允许所有”或启用交互式权限。`,
    }
  }

  /**
   * 执行工具调用列表
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    toolMap: Map<string, RuntimeToolDefinition>,
    ctx: {
      cwd: string
      sessionId: string
      abortSignal?: AbortSignal
      permissionMode?: import('@proma/shared').PromaPermissionMode
      canUseTool?: CanUseToolCallback
    },
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = []

    for (const tc of toolCalls) {
      const tool = toolMap.get(tc.name)
      if (!tool) {
        results.push({
          toolCallId: tc.id,
          content: `未知工具: ${tc.name}`,
          isError: true,
        })
        continue
      }

      // 权限检查
      const permission = await this.checkToolPermission(tc.name, tc.arguments, ctx)
      if (!permission.allowed) {
        results.push({
          toolCallId: tc.id,
          content: permission.message || `权限被拒绝：${tc.name}`,
          isError: true,
        })
        continue
      }

      try {
        const result = await tool.execute(tc.arguments, ctx)
        results.push({
          toolCallId: tc.id,
          content: result.content,
          isError: result.isError,
          generatedAttachments: result.generatedAttachments,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({
          toolCallId: tc.id,
          content: `工具执行失败: ${message}`,
          isError: true,
        })
      }
    }

    return results
  }
}

/** 从任意错误中提取可读消息 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error) || '未知错误'
}
