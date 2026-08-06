/**
 * Provider-Agnostic Agent 适配器
 *
 * 实现 AgentProviderAdapter 接口，不依赖 Claude Agent SDK。
 * 基于 @gravitas/core 的 ProviderAdapter 实现多轮工具调用循环。
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
  SDKUserMessageInput,
  FileAttachment,
  AgentGoalCheckpoint,
  McpServerEntry,
  PromaPermissionMode,
  ProviderType,
} from '@gravitas/shared'
import type {
  ProviderAdapter,
  ToolCall,
  ToolResult,
  ContinuationMessage,
  StreamEvent,
  ThinkingBlock,
} from '@gravitas/core'
import { getAdapter, streamSSE } from '@gravitas/core'
import { getFetchFn } from '../proxy-fetch'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { createCoreTools, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME, GOAL_CHECKPOINT_TOOL_NAME } from '../agent-runtime/tool-registry'
import type { RuntimeToolDefinition } from '../agent-runtime/types'
import { buildAgentSystemPrompt, sdkMessagesToChatMessages } from '../agent-runtime/prompt-builder'
import { maybeAutoCompact, compactSessionNow, COMPACT_CONTEXT_TOOL_NAME } from '../agent-runtime/context-compaction'
import { getAgentSessionSDKMessages } from '../agent-session-manager'
import { enrichMessageWithDocuments, enrichHistoryWithDocuments, getImageAttachmentData } from '../agent-runtime/attachment-enrichment'
import { withRetry } from '../agent-runtime/retry'
import { isTransientNetworkError } from '../error-patterns'
import { isImageAttachment } from '../attachment-service'
import type { RuntimeMessage } from '../agent-runtime/types'
import { ElectronRuntimeMcpService, type RuntimeMcpService } from '../agent-runtime/runtime-mcp-service'
import { getWorkspaceSkills } from '../agent-workspace-manager'
import type { SkillPromptContext } from '../agent-runtime/prompt-builder'

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

/**
 * 工具调用执行上下文（executeTools 系列方法共用）
 */
interface ToolCallExecutionCtx {
  cwd: string
  sessionId: string
  abortSignal?: AbortSignal
  permissionMode?: PromaPermissionMode
  planModeEntered?: boolean
  canUseTool?: CanUseToolCallback
  onEnterPlanMode?: () => void
  onExitPlanMode?: ProviderAgnosticAgentQueryOptions['onExitPlanMode']
  onAskUser?: ProviderAgnosticAgentQueryOptions['onAskUser']
  runSubAgent?: ProviderAgnosticAgentQueryOptions['runSubAgent']
  onGoalCheckpoint?: ProviderAgnosticAgentQueryOptions['onGoalCheckpoint']
  mcpManager?: import('../agent-runtime/mcp-client').McpClientManager
  setPermissionMode?: (mode: PromaPermissionMode) => void
  /** 上下文压缩所需的模型凭据（CompactContext 工具拦截时使用） */
  compaction?: {
    provider: ProviderType
    adapterProvider?: ProviderType
    apiKey: string
    baseUrl: string
    model: string
  }
  /** 当前工作区 slug（ReadSkill 工具读取 Skill 用） */
  workspaceSlug?: string
}

/**
 * 必须串行执行的工具：有副作用 / 顺序依赖 / 交互阻塞 / 修改会话状态。
 * 这类工具不能与其他工具并发，否则会破坏语义（如 AskUser 阻塞等待用户、
 * ExitPlan 提交审批、CompactContext 改写会话历史、GoalCheckpoint 原子持久化）。
 * 其余普通工具（含 Agent/SubAgent 委派、Read/Write/Bash/Web 等）可靠并行执行。
 */
const SEQUENTIAL_TOOL_NAMES = new Set<string>([
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  GOAL_CHECKPOINT_TOOL_NAME,
  COMPACT_CONTEXT_TOOL_NAME,
])

/** Provider-Agnostic 查询选项（扩展通用输入） */
export interface ProviderAgnosticAgentQueryOptions extends AgentQueryInput {
  /** 实际选择底层 ProviderAdapter 的供应商；DeepSeek 在 Proma runtime 下使用 OpenAI adapter */
  adapterProvider?: import('@gravitas/shared').ProviderType
  /** 最大工具调用轮次 */
  maxTurns?: number
  /** 系统提示词 */
  systemPrompt?: string
  /** 权限模式 */
  permissionMode?: import('@gravitas/shared').PromaPermissionMode
  /** 自定义权限检查回调；未提供时按 permissionMode 做本地兜底判断 */
  canUseTool?: CanUseToolCallback
  /** 历史 SDKMessage（阶段 2：多轮会话上下文） */
  historyMessages?: import('@gravitas/shared').SDKMessage[]
  /** 最大 LLM 请求重试次数 */
  maxRetries?: number
  /** 工作区 MCP 服务器配置 */
  mcpServers?: Record<string, McpServerEntry>
  /** 工作区 slug，用于 MCP OAuth token 隔离 */
  workspaceSlug?: string
  /** MCP OAuth 需要用户授权时回调 */
  onMcpAuthRequired?: (payload: { workspaceSlug: string; serverName: string }) => void
  /** 进入 Plan 模式通知回调 */
  onEnterPlanMode?: () => void
  /** 退出 Plan 模式审批回调 */
  onExitPlanMode?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ behavior: 'allow'; targetMode?: PromaPermissionMode } | { behavior: 'deny'; message: string }>
  /** AskUserQuestion 工具回调：发送问题到 UI 并等待用户回答 */
  onAskUser?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ behavior: 'allow'; answers: Record<string, string> } | { behavior: 'deny'; message: string }>
  /** Sub Agent 运行回调 */
  runSubAgent?: import('../agent-runtime/types').ToolContext['runSubAgent']
  /** GoalCheckpoint 回调；存在激活 Goal 时由编排层注入。 */
  onGoalCheckpoint?: (checkpoint: AgentGoalCheckpoint) => Promise<void>
  /** 额外内置工具（如 collaboration 协作子会话）；以 name 去重追加到核心工具之后 */
  extraTools?: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
    execute(input: Record<string, unknown>): Promise<string>
  }>
  /** 用户通过命令菜单/引用面板显式选择的 Skill slug 列表（自研 runtime 按需提示读取） */
  skillMentions?: string[]
}

/** 活跃会话状态 */
interface ActiveSession {
  controller: AbortController
  permissionMode: PromaPermissionMode
  /** 是否已取消（abort） */
  cancelled?: boolean
  /** 是否软中断（interrupt 后等待追加消息） */
  interrupted?: boolean
  /** 流式期间追加的用户消息队列 */
  queuedMessages?: SDKUserMessageInput[]
  /** 唤醒等待队列的 resolve（waitForQueuedMessage） */
  resolveQueuedMessage?: () => void
}

export class ProviderAgnosticAgentAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActiveSession>()

  constructor(private readonly mcpService: RuntimeMcpService = new ElectronRuntimeMcpService()) {}

  /** 发起查询，返回 SDKMessage 异步迭代流 */
  async *query(input: ProviderAgnosticAgentQueryOptions): AsyncIterable<SDKMessage> {
    const {
      sessionId,
      prompt,
      model,
      provider,
      adapterProvider,
      apiKey,
      baseUrl,
      cwd,
      abortSignal,
      maxTurns = 25,
      systemPrompt,
      attachments,
      mcpServers,
      workspaceSlug,
      onMcpAuthRequired,
      onEnterPlanMode,
      onExitPlanMode,
      onAskUser,
      runSubAgent,
      extraTools,
      onGoalCheckpoint,
      skillMentions,
    } = input

    if (!provider || !apiKey || !baseUrl || !cwd) {
      throw new Error('Provider-Agnostic Runtime 需要 provider、apiKey、baseUrl、cwd')
    }

    const adapter = getAdapter(adapterProvider ?? provider)
    const controller = new AbortController()
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const activeSession: ActiveSession = {
      controller,
      permissionMode: input.permissionMode ?? 'auto',
    }
    this.activeSessions.set(sessionId, activeSession)

    // 加载 MCP 工具（优先使用跨会话缓存，减少重复连接）
    let mcpManager: import('../agent-runtime/mcp-client').McpClientManager | undefined
    let mcpRelease: (() => void) | undefined
    let mcpTools: RuntimeToolDefinition[] = []
    if (mcpServers && Object.keys(mcpServers).length > 0 && workspaceSlug) {
      try {
        const acquired = await this.mcpService.acquireClientManager({
          workspaceSlug,
          mcpServers,
          cwd,
          onMcpAuthRequired,
        })
        mcpManager = acquired.manager
        mcpRelease = acquired.release
        mcpTools = await mcpManager.listAllTools(controller.signal)
        console.log(`[Agent Runtime] 已加载 ${mcpTools.length} 个 MCP 工具`)
      } catch (err) {
        console.error('[Agent Runtime] 加载 MCP 工具失败，将继续使用核心工具:', err)
      }
    }
    const tools: RuntimeToolDefinition[] = [
      ...createCoreTools({ workspaceSlug }).filter((tool) => tool.name !== GOAL_CHECKPOINT_TOOL_NAME || Boolean(onGoalCheckpoint)),
      ...mcpTools,
      ...(extraTools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: { type: 'object' as const, properties: tool.parameters as Record<string, never>, required: [] },
        async execute(input: unknown): Promise<import('@gravitas/core').ToolResult> {
          const content = await tool.execute((input ?? {}) as Record<string, unknown>)
          return { toolCallId: '', content, isError: false }
        },
      })),
    ]
    const toolMap = new Map(tools.map((t) => [t.name, t]))
    const effectiveSystemPrompt = buildAgentSystemPrompt(systemPrompt, cwd, buildSkillPromptContext(workspaceSlug))
    // 用户在消息中显式要求读取的 Skill：注入指令块引导模型先 ReadSkill 再执行
    const skillRequestedBlock = buildSkillRequestedBlock(skillMentions, prompt)

    // Plan 模式状态
    let planModeEntered = activeSession.permissionMode === 'plan'

    // 累积本轮所有消息（用于持久化和事件流）
    const runtimeMessages: RuntimeMessage[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheCreationTokens = 0

    try {
      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)

      // 自动上下文压缩：历史条数超过阈值时，用 LLM 摘要早期历史并保留最近消息。
      // 压缩后以新历史继续本轮；boundary 摘要已持久化，后续 query 自然读到。
      let effectiveHistoryMessages = input.historyMessages ?? []
      if (effectiveHistoryMessages.length > 0 && provider && apiKey && baseUrl) {
        const auto = await maybeAutoCompact({
          sessionId,
          provider,
          adapterProvider,
          apiKey,
          baseUrl,
          model: model || '',
          historyMessages: effectiveHistoryMessages,
          signal: controller.signal,
        })
        if (auto.compacted) {
          effectiveHistoryMessages = auto.history
          console.log(`[Agent Runtime] 已自动压缩上下文: sessionId=${sessionId}, 摘要 ${auto.summary?.length ?? 0} chars`)
        }
      }

      // 流式追加支持：外层 while 每轮处理一个用户消息（首轮为原始 prompt，追加轮为 queued 文本）。
      let currentTurnPrompt = prompt
      let currentTurnImages: FileAttachment[] = attachments?.filter((att) => isImageAttachment(att.mediaType)) ?? []

      while (!activeSession.cancelled) {
        // 本轮产生的 SDKMessage（assistant + tool_result），跨轮追加时纳入历史
        const turnMessages: SDKMessage[] = []
        try {
        // 阶段 2：加载历史消息，并提取历史消息中的文档附件文本（每轮重建）
        const rawHistory = effectiveHistoryMessages.length > 0 ? sdkMessagesToChatMessages(effectiveHistoryMessages) : []
        const history = await enrichHistoryWithDocuments(rawHistory)

        // 处理当前用户消息的多模态附件（首轮有附件；追加轮为纯文本）
        // 注：enrichMessageWithDocuments 只处理文档附件（提取文本）；图片附件经 readImageAttachments 注入
        const enrichedPrompt = await enrichMessageWithDocuments(currentTurnPrompt, currentTurnPrompt === prompt ? attachments : undefined)
        // 用户显式请求 Skill 时，在 prompt 头部注入指令块引导先 ReadSkill（仅首轮）
        const promptWithSkillRequest = skillRequestedBlock && currentTurnPrompt === prompt
          ? `${skillRequestedBlock}\n\n${enrichedPrompt}`
          : enrichedPrompt

        // 初始用户消息
        const userMessage: RuntimeMessage = {
          role: 'user',
          content: promptWithSkillRequest,
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
          userMessage: promptWithSkillRequest,
          systemMessage: effectiveSystemPrompt,
          readImageAttachments: () => getImageAttachmentData(currentTurnImages),
          attachments: currentTurnImages,
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
        let roundUsage: import('@gravitas/core').StreamUsageEvent['usage'] | undefined

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
        turnMessages.push(assistantMessage as unknown as SDKMessage)
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
          permissionMode: activeSession.permissionMode,
          planModeEntered,
          canUseTool: input.canUseTool,
          compaction: {
            provider,
            adapterProvider,
            apiKey,
            baseUrl,
            model: model || '',
          },
          onEnterPlanMode: () => {
            planModeEntered = true
            onEnterPlanMode?.()
          },
          onExitPlanMode,
          onAskUser,
          runSubAgent,
          onGoalCheckpoint,
          mcpManager,
          workspaceSlug,
          setPermissionMode: (mode) => {
            activeSession.permissionMode = mode
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
          message: { content: toolResultBlocks as unknown as import('@gravitas/shared').SDKUserContentBlock[] },
          parent_tool_use_id: null,
          session_id: sessionId,
        }
        turnMessages.push(toolResultMessage as unknown as SDKMessage)
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
        } catch (error) {
          // 软中断：controller.abort() 让 streamSSE 抛错；若有追加消息则继续下一轮，否则重新抛出
          if (!activeSession.interrupted || activeSession.cancelled) throw error
          activeSession.interrupted = false
          await this.waitForQueuedMessage(activeSession)
          if (activeSession.cancelled) break
          const queuedInterrupt = activeSession.queuedMessages?.shift()
          if (!queuedInterrupt) break
          effectiveHistoryMessages = [...effectiveHistoryMessages, ...turnMessages]
          currentTurnPrompt = queuedInterrupt.message.content
          currentTurnImages = []
          continue
        }

        // 本轮结束：检查流式追加队列；有追加则纳入历史继续下一轮，无则结束
        const queued = activeSession.queuedMessages?.shift()
        if (!queued) break
        effectiveHistoryMessages = [...effectiveHistoryMessages, ...turnMessages]
        currentTurnPrompt = queued.message.content
        currentTurnImages = []
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
      // 释放缓存引用（缓存负责实际断开连接）
      mcpRelease?.()
    }
  }

  /** 中止指定会话 */
  abort(sessionId: string): void {
    const session = this.activeSessions.get(sessionId)
    if (session) {
      session.cancelled = true
      session.controller.abort()
      session.resolveQueuedMessage?.()
      this.activeSessions.delete(sessionId)
    }
  }

  /** 软中断当前 turn：终止本轮流式输出，等待流式追加消息后继续下一轮 */
  async interruptQuery(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    session.interrupted = true
    session.controller.abort()
  }

  /**
   * 流式期间追加用户消息。
   * 消息进入队列；query 外层 while 在每轮结束后取出一条作为下一轮用户输入。
   */
  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const session = this.activeSessions.get(sessionId)
    if (!session) {
      throw new Error(`[Agent Runtime] 无活跃会话可追加消息: ${sessionId}`)
    }
    session.queuedMessages ??= []
    session.queuedMessages.push(message)
    session.resolveQueuedMessage?.()
    session.resolveQueuedMessage = undefined
  }

  /** 等待流式追加队列出现消息（软中断后 query 等待新输入时使用） */
  private async waitForQueuedMessage(session: ActiveSession): Promise<void> {
    if (session.queuedMessages && session.queuedMessages.length > 0) return
    await new Promise<void>((resolve) => {
      session.resolveQueuedMessage = resolve
    })
  }

  /** 动态切换活跃查询的权限模式 */
  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const session = this.activeSessions.get(sessionId)
    if (!session) return
    if (mode === 'safe' || mode === 'auto' || mode === 'plan' || mode === 'bypassPermissions') {
      session.permissionMode = mode
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

    // Safe 模式本地兜底：仅放行只读工具与只读 Bash，默认拒绝写操作
    if (ctx.permissionMode === 'safe') {
      const safeAllowedTools = new Set([
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'RecallMemory',
        'WebBridgeSnapshot',
        'WebBridgeScreenshot',
        'WebBridgeScroll',
        'WebBridgeChromeTargets',
        'ComputerUseStatus',
        'ComputerUseCapabilities',
        'ComputerUseFrontmostApplication',
        'ComputerUseFrontmostWindow',
        'ComputerUseDisplays',
        'TodoRead',
        'TaskOutput',
        'TaskList',
        'TaskGet',
        'ListMcpResourcesTool',
        'ReadMcpResourceTool',
        ASK_USER_QUESTION_TOOL_NAME,
      ])
      if (safeAllowedTools.has(toolName)) {
        return { allowed: true }
      }

      if (toolName === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : ''
        if (isBashCommandReadOnly(command)) {
          return { allowed: true }
        }
      }

      return { allowed: false, message: '安全模式下不允许执行写操作，请切换到自动审批或完全自动模式' }
    }

    // Plan 模式本地兜底：与旧 Claude SDK 路径保持一致
    if (ctx.permissionMode === 'plan' || ctx.planModeEntered) {
      const planAllowedTools = new Set([
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'RecallMemory',
        'WebBridgeSnapshot',
        'WebBridgeScreenshot',
        'WebBridgeScroll',
        'WebBridgeChromeTargets',
        'ComputerUseStatus',
        'ComputerUseCapabilities',
        'ComputerUseFrontmostApplication',
        'ComputerUseFrontmostWindow',
        'ComputerUseDisplays',
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
   *
   * 智能分组并行：同一轮中，可并行的独立工具（含 Agent/SubAgent 委派、
   * Read/Write/Bash/Web 等普通工具）并发执行以提升总耗时；必须串行执行的
   * 工具（AskUser/Plan/CompactContext/GoalCheckpoint，见 SEQUENTIAL_TOOL_NAMES）
   * 保持逐个顺序执行，避免破坏交互或会话状态语义。
   *
   * 例如主 Agent 在同一轮委托多个 SubAgent 时，它们会并行运行并各自返回摘要。
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    toolMap: Map<string, RuntimeToolDefinition>,
    ctx: ToolCallExecutionCtx,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = []
    // 可并行执行的工具调用批量缓冲
    let parallelBatch: ToolCall[] = []

    /** 将当前累积的可并行工具 batch 并发执行，结果暂存到 results */
    const flushParallelBatch = async (): Promise<void> => {
      if (parallelBatch.length === 0) return
      const batch = parallelBatch
      parallelBatch = []
      // 并发放飞所有可并行的单工具执行；各工具通过 tool_use_id 关联，相互独立
      const outcomes = await Promise.all(
        batch.map(async (tc) => ({ result: await this.executeSingleToolCall(tc, toolMap, ctx) })),
      )
      for (const { result } of outcomes) results.push(result)
    }

    for (const tc of toolCalls) {
      if (SEQUENTIAL_TOOL_NAMES.has(tc.name)) {
        // 遇到必须串行的工具：先按序清空之前累积的并行 batch，再执行本工具
        await flushParallelBatch()
        results.push(await this.executeSingleToolCall(tc, toolMap, ctx))
      } else {
        parallelBatch.push(tc)
      }
    }
    await flushParallelBatch()

    return results
  }

  /**
   * 执行单个工具调用（并行批中逐个发起；串行工具有序调用）
   */
  private async executeSingleToolCall(
    tc: ToolCall,
    toolMap: Map<string, RuntimeToolDefinition>,
    ctx: ToolCallExecutionCtx,
  ): Promise<ToolResult> {
    // CompactContext：立即压缩当前会话历史（摘要早期 + 保留最近），下一轮生效
    if (tc.name === COMPACT_CONTEXT_TOOL_NAME) {
      if (ctx.compaction) {
        try {
          const currentHistory = getAgentSessionSDKMessages(ctx.sessionId)
          const result = await compactSessionNow({
            sessionId: ctx.sessionId,
            ...ctx.compaction,
            historyMessages: currentHistory,
            signal: ctx.abortSignal,
          })
          if (result.compacted) {
            return {
              toolCallId: tc.id,
              content: `上下文已压缩。早期历史已摘要（${result.summary?.length ?? 0} 字符），最近 ${Math.max(0, result.history.length - 1)} 条保留；本轮继续，下一轮对话将基于压缩后的摘要。`,
              isError: false,
            }
          }
          return { toolCallId: tc.id, content: '上下文暂不需要压缩（历史较短或过小）。', isError: false }
        } catch (error) {
          return { toolCallId: tc.id, content: `上下文压缩失败: ${getErrorMessage(error)}`, isError: true }
        }
      }
      return { toolCallId: tc.id, content: '当前 Runtime 未配置上下文压缩参数。', isError: true }
    }

    // EnterPlanMode：标记进入 Plan 模式并通知 UI
    if (tc.name === ENTER_PLAN_MODE_TOOL_NAME) {
      ctx.onEnterPlanMode?.()
      return { toolCallId: tc.id, content: '已进入 Plan 模式', isError: false }
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
          return { toolCallId: tc.id, content: `已退出 Plan 模式，切换到 ${result.targetMode ?? '默认'} 模式`, isError: false }
        }
        return { toolCallId: tc.id, content: result.message || '用户拒绝了计划', isError: true }
      }
      return { toolCallId: tc.id, content: '已退出 Plan 模式', isError: false }
    }

    // AskUserQuestion：直接走交互式问答回调，不经过通用权限检查
    if (tc.name === ASK_USER_QUESTION_TOOL_NAME) {
      if (ctx.onAskUser) {
        const signal = ctx.abortSignal ?? new AbortController().signal
        const result = await ctx.onAskUser(tc.arguments, signal)
        if (result.behavior === 'allow') {
          const answerBlocks = Object.entries(result.answers)
            .map(([q, a]) => `Q: ${q}\nA: ${a}`)
            .join('\n\n')
          return {
            toolCallId: tc.id,
            content: `用户回答如下：\n\n${answerBlocks}\n\nanswers JSON: ${JSON.stringify(result.answers)}`,
            isError: false,
          }
        }
        return { toolCallId: tc.id, content: result.message || '用户拒绝回答', isError: true }
      }
      return { toolCallId: tc.id, content: '当前 Runtime 未配置 AskUser 回调', isError: true }
    }

    // GoalCheckpoint 不属于权限工具，也不允许进入普通工具实现；由 Goal 控制平面原子持久化。
    if (tc.name === GOAL_CHECKPOINT_TOOL_NAME) {
      if (!ctx.onGoalCheckpoint) {
        return { toolCallId: tc.id, content: '当前会话没有激活的 Goal，不能提交检查点。', isError: true }
      }
      try {
        await ctx.onGoalCheckpoint(toGoalCheckpoint(tc.arguments))
        return { toolCallId: tc.id, content: 'Goal 检查点已持久化。', isError: false }
      } catch (error) {
        return { toolCallId: tc.id, content: `Goal 检查点无效: ${getErrorMessage(error)}`, isError: true }
      }
    }

    const tool = toolMap.get(tc.name)
    if (!tool) {
      return {
        toolCallId: tc.id,
        content: `未知工具: ${tc.name}`,
        isError: true,
      }
    }

    // 权限检查
    const permission = await this.checkToolPermission(tc.name, tc.arguments, ctx)
    if (!permission.allowed) {
      return {
        toolCallId: tc.id,
        content: permission.message || `权限被拒绝：${tc.name}`,
        isError: true,
      }
    }

    try {
      const result = await tool.execute(tc.arguments, ctx)
      return {
        toolCallId: tc.id,
        content: result.content,
        isError: result.isError,
        generatedAttachments: result.generatedAttachments,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        toolCallId: tc.id,
        content: `工具执行失败: ${message}`,
        isError: true,
      }
    }
  }
}

/** 从任意错误中提取可读消息 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error) || '未知错误'
}

function toGoalCheckpoint(input: Record<string, unknown>): AgentGoalCheckpoint {
  const outcome = input.outcome
  const summary = input.summary
  if (outcome !== 'continue' && outcome !== 'waiting' && outcome !== 'blocked' && outcome !== 'complete') {
    throw new Error('outcome 必须是 continue、waiting、blocked 或 complete')
  }
  if (typeof summary !== 'string') throw new Error('summary 必须是字符串')
  const completed = Array.isArray(input.completed) ? input.completed.filter((value): value is string => typeof value === 'string') : []
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.flatMap((value) => {
      if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.value !== 'string') return []
      if (!['test', 'command', 'file', 'tool', 'user'].includes(value.kind)) return []
      return [{ kind: value.kind as AgentGoalCheckpoint['evidence'][number]['kind'], value: value.value }]
    })
    : []
  return {
    outcome,
    summary,
    completed,
    evidence,
    ...(typeof input.nextAction === 'string' ? { nextAction: input.nextAction } : {}),
    ...(typeof input.blocker === 'string' ? { blocker: input.blocker } : {}),
    ...(isWakeTrigger(input.wakeTrigger) ? { wakeTrigger: input.wakeTrigger } : {}),
  }
}

function isWakeTrigger(value: unknown): value is AgentGoalCheckpoint['wakeTrigger'] {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'immediate' || value.type === 'user_input') return true
  if (value.type === 'at') return typeof value.wakeAt === 'number'
  if (value.type === 'interaction') return typeof value.requestId === 'string'
  if (value.type === 'external_task') return typeof value.taskId === 'string'
  return value.type === 'file_change' && Array.isArray(value.paths) && value.paths.every((path) => typeof path === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

// ===== Skill 支持（自研 runtime：提示词注入 + ReadSkill 引导） =====

/** 用户在 prompt 中显式请求 Skill 的命令模式：/skill:xxx */
const SKILL_COMMAND_PATTERN = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g

/**
 * 构建 Skill 系统提示词上下文（available_skills 清单）。
 * workspaceSlug 为空或无可读 skills 目录时返回 undefined，不注入 skill 块。
 */
function buildSkillPromptContext(workspaceSlug: string | undefined): SkillPromptContext | undefined {
  if (!workspaceSlug) return undefined
  try {
    const skills = getWorkspaceSkills(workspaceSlug).filter((s) => s.enabled)
    if (skills.length === 0) return undefined
    return { workspaceSlug, skills }
  } catch (error) {
    console.warn('[Agent Runtime] 读取工作区 Skills 失败:', error)
    return undefined
  }
}

/**
 * 构建 skill 请求指令块。
 *
 * 合并两类请求源：显式 skillMentions（命令菜单选择）+ prompt 内 /skill:xxx。
 * 有请求时才返回非空块，引导模型先用 ReadSkill 读取全文再执行。
 */
function buildSkillRequestedBlock(skillMentions: string[] | undefined, prompt: string): string | undefined {
  const requested = new Set<string>()

  for (const slug of skillMentions ?? []) {
    if (slug) requested.add(slug)
  }
  for (const match of prompt.matchAll(SKILL_COMMAND_PATTERN)) {
    const name = match[1]?.trim()
    if (name) requested.add(name)
  }

  if (requested.size === 0) return undefined

  const lines = [...requested].map((slug) => `- ${slug}`).join('\n')
  return [
    '<skill_requested>',
    '用户在本次消息中明确要求使用以下 Skill。请先调用 ReadSkill 读取对应 SKILL.md 全文，再严格按其说明完成任务。',
    lines,
    '</skill_requested>',
  ].join('\n')
}
