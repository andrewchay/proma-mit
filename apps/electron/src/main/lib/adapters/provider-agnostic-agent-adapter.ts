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
  McpServerEntry,
  PromaPermissionMode,
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
import { createCoreTools, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from '../agent-runtime/tool-registry'
import { McpClientManager } from '../agent-runtime/mcp-client'
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
  /** 工作区 MCP 服务器配置 */
  mcpServers?: Record<string, McpServerEntry>
  /** 进入 Plan 模式通知回调 */
  onEnterPlanMode?: () => void
  /** 退出 Plan 模式审批回调 */
  onExitPlanMode?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ behavior: 'allow'; targetMode?: PromaPermissionMode } | { behavior: 'deny'; message: string }>
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
      mcpServers,
      onEnterPlanMode,
      onExitPlanMode,
    } = input

    if (!provider || !apiKey || !baseUrl || !cwd) {
      throw new Error('Provider-Agnostic Runtime 需要 provider、apiKey、baseUrl、cwd')
    }

    const adapter = getAdapter(provider)
    const controller = new AbortController()
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    this.activeSessions.set(sessionId, { controller })

    // 加载 MCP 工具
    const mcpManager = mcpServers && Object.keys(mcpServers).length > 0
      ? new McpClientManager(mcpServers, cwd, { abortSignal: controller.signal })
      : undefined
    let mcpTools: RuntimeToolDefinition[] = []
    if (mcpManager) {
      try {
        await mcpManager.connectAll()
        mcpTools = await mcpManager.listAllTools()
        console.log(`[Agent Runtime] 已加载 ${mcpTools.length} 个 MCP 工具`)
      } catch (err) {
        console.error('[Agent Runtime] 加载 MCP 工具失败，将继续使用核心工具:', err)
      }
    }
    const tools = [...createCoreTools(), ...mcpTools]
    const toolMap = new Map(tools.map((t) => [t.name, t]))
    const effectiveSystemPrompt = buildAgentSystemPrompt(systemPrompt, cwd)

    // Plan 模式状态
    let currentPermissionMode: PromaPermissionMode = input.permissionMode ?? 'auto'
    let planModeEntered = currentPermissionMode === 'plan'

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
          providerType: provider,
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
        let roundUsage: import('@proma/core').StreamUsageEvent['usage'] | undefined

        const handleStreamEvent = (event: StreamEvent): void => {
          if (event.type === 'chunk') {
            currentContent += event.delta
          } else if (event.type === 'reasoning') {
            currentReasoning += event.delta
          } else if (event.type === 'tool_call_start') {
            // 工具调用开始，由 streamSSE 累积参数
          } else if (event.type === 'usage') {
            roundUsage = event.usage
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
        // 优先使用流式回调中的 usage，其次使用 streamSSE 汇总返回值
        const finalRoundUsage = roundUsage ?? result.usage

        // 累积 token 用量（最佳 effort，部分 provider 不返回）
        if (finalRoundUsage) {
          totalInputTokens += finalRoundUsage.input_tokens ?? 0
          totalOutputTokens += finalRoundUsage.output_tokens ?? 0
          totalCacheReadTokens += finalRoundUsage.cache_read_input_tokens ?? finalRoundUsage.prompt_cache_hit_tokens ?? 0
          totalCacheCreationTokens += finalRoundUsage.cache_creation_input_tokens ?? finalRoundUsage.prompt_cache_miss_tokens ?? 0
          console.log(
            `[Agent Runtime] 第 ${round} 轮用量: input=${finalRoundUsage.input_tokens ?? '-'}, output=${finalRoundUsage.output_tokens ?? '-'}, cache_hit=${finalRoundUsage.prompt_cache_hit_tokens ?? finalRoundUsage.cache_read_input_tokens ?? '-'}, cache_miss=${finalRoundUsage.prompt_cache_miss_tokens ?? finalRoundUsage.cache_creation_input_tokens ?? '-'}`
          )
        }

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
          permissionMode: currentPermissionMode,
          planModeEntered,
          canUseTool: input.canUseTool,
          onEnterPlanMode: () => {
            planModeEntered = true
            onEnterPlanMode?.()
          },
          onExitPlanMode,
          setPermissionMode: (mode) => {
            currentPermissionMode = mode
            planModeEntered = false
          },
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
      if (mcpManager) {
        mcpManager.disconnect().catch((err: unknown) => {
          console.warn('[Agent Runtime] 断开 MCP 服务器失败:', err)
        })
      }
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
   * - plan 模式：与 Claude SDK 路径对齐，允许只读工具、写 .md 计划文件、只读 Bash、MCP 工具
   * - 未提供 canUseTool 回调时：只读工具（Read/Grep）自动放行，写工具默认拒绝
   * - 提供 canUseTool 回调时：委托给回调（可接入 AgentPermissionService）
   */
  private async checkToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    ctx: {
      abortSignal?: AbortSignal
      permissionMode?: PromaPermissionMode
      planModeEntered?: boolean
      canUseTool?: CanUseToolCallback
    },
  ): Promise<ToolPermissionResult> {
    if (ctx.permissionMode === 'bypassPermissions') {
      return { allowed: true }
    }

    // Plan 模式本地兜底：与旧 Claude SDK 路径保持一致
    if (ctx.permissionMode === 'plan' || ctx.planModeEntered) {
      const planAllowedTools = new Set([
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Agent',
        'TodoRead',
        'TodoWrite',
        'TaskOutput',
        'TaskCreate',
        'TaskUpdate',
        'TaskList',
        'TaskGet',
        'ListMcpResourcesTool',
        'ReadMcpResourceTool',
        ENTER_PLAN_MODE_TOOL_NAME,
        EXIT_PLAN_MODE_TOOL_NAME,
      ])
      if (planAllowedTools.has(toolName)) {
        return { allowed: true }
      }

      // 允许 Write/Edit 到任意 .md 文件（计划文档）
      if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = typeof input.file_path === 'string' ? input.file_path : ''
        if (filePath.toLowerCase().endsWith('.md')) {
          return { allowed: true }
        }
      }

      // Bash 工具：只读命令允许，写操作拒绝
      if (toolName === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : ''
        if (isBashCommandReadOnly(command)) {
          return { allowed: true }
        }
        return { allowed: false, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
      }

      // MCP 工具（以 mcp__ 开头）允许调研调用
      if (toolName.startsWith('mcp__')) {
        return { allowed: true }
      }

      return { allowed: false, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
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
      permissionMode?: PromaPermissionMode
      planModeEntered?: boolean
      canUseTool?: CanUseToolCallback
      onEnterPlanMode?: () => void
      onExitPlanMode?: ProviderAgnosticAgentQueryOptions['onExitPlanMode']
      setPermissionMode?: (mode: PromaPermissionMode) => void
    },
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = []

    for (const tc of toolCalls) {
      // EnterPlanMode：标记进入 Plan 模式并通知 UI
      if (tc.name === ENTER_PLAN_MODE_TOOL_NAME) {
        ctx.onEnterPlanMode?.()
        results.push({ toolCallId: tc.id, content: '已进入 Plan 模式', isError: false })
        continue
      }

      // ExitPlanMode：提交计划审批，等待用户响应
      if (tc.name === EXIT_PLAN_MODE_TOOL_NAME) {
        if (ctx.onExitPlanMode) {
          const signal = ctx.abortSignal ?? new AbortController().signal
          const result = await ctx.onExitPlanMode(tc.arguments, signal)
          if (result.behavior === 'allow') {
            if (result.targetMode) {
              ctx.setPermissionMode?.(result.targetMode)
            }
            results.push({ toolCallId: tc.id, content: `已退出 Plan 模式，切换到 ${result.targetMode ?? '默认'} 模式`, isError: false })
          } else {
            results.push({ toolCallId: tc.id, content: result.message || '用户拒绝了计划', isError: true })
          }
        } else {
          results.push({ toolCallId: tc.id, content: '已退出 Plan 模式', isError: false })
        }
        continue
      }

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

/**
 * 判断 Bash 命令是否为只读操作
 *
 * 与 agent-orchestrator.ts 中旧 Claude 路径保持一致，
 * 用于 Plan 模式下允许安全的调研命令。
 */
function isBashCommandReadOnly(command: string): boolean {
  // 输出重定向：匹配未被数字或 & 前置的 > 符号
  if (/(?<![0-9&])>/.test(command)) return false
  // 破坏性文件操作
  if (/\b(rm|rmdir)\s/.test(command)) return false
  if (/\bsed\s+[^|&;]*-i/.test(command)) return false
  if (/\b(chmod|chown|chattr|truncate)\s/.test(command)) return false
  if (/\b(mv|cp)\s/.test(command)) return false
  if (/\b(mkdir|touch|mktemp)\s/.test(command)) return false
  // 包管理器写操作
  if (/\b(npm|pnpm|yarn|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|link|unlink)\b/.test(command)) return false
  if (/\bpip[23]?\s+(install|uninstall|upgrade)\b/.test(command)) return false
  if (/\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|purge|uninstall|upgrade)\b/.test(command)) return false
  // Git 写操作
  if (/\bgit\s+(commit|push|checkout\s+-[bB]|branch\s+-[mMdD]|merge\b|rebase\b|reset\b|stash\s+(drop|pop)\b|add\b|apply\b|cherry-pick\b)/.test(command)) return false
  // 进程控制
  if (/\b(kill|killall|pkill)\s/.test(command)) return false
  // 脚本执行
  if (/\b(node|python[23]?|ruby|perl|php)\s+[^-]/.test(command)) return false
  return true
}
