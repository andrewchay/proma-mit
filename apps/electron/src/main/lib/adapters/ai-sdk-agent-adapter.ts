/**
 * Vercel AI SDK Agent Runtime 适配器。
 *
 * 目标是让未来 Web/Server runtime 可以复用同一套模型与工具协议；当前先接入
 * OpenAI-compatible provider，工具执行和权限仍复用 Proma 自己的 runtime 工具层。
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  AgentGoalCheckpoint,
  McpServerEntry,
  PromaPermissionMode,
  SDKMessage,
  SDKUserMessageInput,
} from '@proma/shared'
import { getAgentProviderProtocol, isAgentCompatibleProvider } from '@proma/shared'
import { createCoreTools, GOAL_CHECKPOINT_TOOL_NAME } from '../agent-runtime/tool-registry'
import {
  AISDKRuntimeCore,
  type AISDKCanUseToolCallback,
  type AISDKRuntimeSessionState,
} from '../agent-runtime/ai-sdk-runtime-core'
import { ElectronRuntimeMcpService, type RuntimeMcpService } from '../agent-runtime/runtime-mcp-service'

export interface AISDKAgentQueryOptions extends AgentQueryInput {
  /** 最大工具调用 step 数 */
  maxTurns?: number
  /** 系统提示词 */
  systemPrompt?: string
  /** 权限模式 */
  permissionMode?: PromaPermissionMode
  /** 自定义权限检查回调 */
  canUseTool?: AISDKCanUseToolCallback
  /** 历史 SDKMessage */
  historyMessages?: SDKMessage[]
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
  /** AskUserQuestion 工具回调 */
  onAskUser?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ behavior: 'allow'; answers: Record<string, string> } | { behavior: 'deny'; message: string }>
  /** Sub Agent 运行回调 */
  runSubAgent?: import('../agent-runtime/types').ToolContext['runSubAgent']
  /** GoalCheckpoint 回调；存在激活 Goal 时由编排层注入。 */
  onGoalCheckpoint?: (checkpoint: AgentGoalCheckpoint) => Promise<void>
}

interface ActiveAISDKSession {
  state: AISDKRuntimeSessionState
  queuedMessages: SDKUserMessageInput[]
  interrupted: boolean
  cancelled: boolean
  resolveQueuedMessage?: () => void
}

export class AISDKAgentAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActiveAISDKSession>()
  private readonly runtimeCore = new AISDKRuntimeCore()

  constructor(private readonly mcpService: RuntimeMcpService = new ElectronRuntimeMcpService()) {}

  async *query(input: AISDKAgentQueryOptions): AsyncIterable<SDKMessage> {
    const {
      sessionId,
      prompt,
      model,
      provider,
      apiKey,
      baseUrl,
      cwd,
      abortSignal,
      attachments,
      mcpServers,
      workspaceSlug,
      onMcpAuthRequired,
      maxTurns = 25,
    } = input

    if (!provider || !apiKey || !baseUrl || !cwd || !model) {
      throw new Error('AI SDK Runtime 需要 provider、apiKey、baseUrl、model、cwd')
    }

    if (!isAgentCompatibleProvider(provider, 'ai-sdk')) {
      throw new Error(`AI SDK Runtime 暂不支持 ${provider}`)
    }

    const protocol = getAgentProviderProtocol(provider, 'ai-sdk')

    const activeSession: ActiveAISDKSession = {
      state: {
        controller: createAbortController(abortSignal),
        permissionMode: input.permissionMode ?? 'auto',
        planModeEntered: input.permissionMode === 'plan',
      },
      queuedMessages: [],
      interrupted: false,
      cancelled: false,
    }
    this.activeSessions.set(sessionId, activeSession)

    let mcpRelease: (() => void) | undefined
    try {
      const tools = createCoreTools().filter((tool) => tool.name !== GOAL_CHECKPOINT_TOOL_NAME || Boolean(input.onGoalCheckpoint))
      let mcpManager: import('../agent-runtime/mcp-client').McpClientManager | undefined
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
          tools.push(...await mcpManager.listAllTools(activeSession.state.controller.signal))
          console.log(`[AI SDK Runtime] 已加载 ${tools.length} 个工具（含 MCP）`)
        } catch (err) {
          console.error('[AI SDK Runtime] 加载 MCP 工具失败，将继续使用核心工具:', err)
        }
      }

      let currentPrompt = prompt
      let currentAttachments = attachments
      let historyMessages = input.historyMessages ?? []

      // AI SDK 的一次 streamText 调用不能像 Claude SDK 那样直接向活跃 stream 注入输入。
      // 因此把运行中的追加消息排成下一轮 Agent turn，并将刚完成的一轮纳入历史，
      // 保持用户在输出期间继续追问时的上下文连续性。
      while (!activeSession.cancelled) {
        let messages: SDKMessage[]
        try {
          messages = await this.runtimeCore.runAgentTurn({
            sessionId,
            prompt: currentPrompt,
            modelId: model,
            provider,
            protocol,
            apiKey,
            baseUrl,
            cwd,
            runtimeTools: tools,
            activeSession: activeSession.state,
            maxTurns,
            maxRetries: input.maxRetries ?? 2,
            historyMessages,
            attachments: currentAttachments,
            systemPrompt: input.systemPrompt,
            onAgentEvent: input.onAgentEvent,
            canUseTool: input.canUseTool,
            onEnterPlanMode: input.onEnterPlanMode,
            onExitPlanMode: input.onExitPlanMode,
            onAskUser: input.onAskUser,
            runSubAgent: input.runSubAgent,
            onGoalCheckpoint: input.onGoalCheckpoint,
            mcpManager,
          })
        } catch (error) {
          if (!activeSession.interrupted || activeSession.cancelled) throw error

          activeSession.interrupted = false
          await waitForQueuedMessage(activeSession)
          if (activeSession.cancelled) return

          const queuedMessage = activeSession.queuedMessages.shift()
          if (!queuedMessage) return
          historyMessages = [
            ...historyMessages,
            createQueuedHistoryMessage(currentPrompt, currentAttachments),
          ]
          currentPrompt = queuedMessage.message.content
          currentAttachments = undefined
          activeSession.state.controller = createAbortController(abortSignal)
          continue
        }
        for (const message of messages) {
          yield message
        }

        const queuedMessage = activeSession.queuedMessages.shift()
        if (!queuedMessage) break

        historyMessages = [
          ...historyMessages,
          createQueuedHistoryMessage(currentPrompt, currentAttachments),
          ...messages,
        ]
        currentPrompt = queuedMessage.message.content
        currentAttachments = undefined
      }
    } finally {
      this.activeSessions.delete(sessionId)
      mcpRelease?.()
    }
  }

  abort(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.cancelled = true
    active.state.controller.abort()
    active.resolveQueuedMessage?.()
    this.activeSessions.delete(sessionId)
  }

  async interruptQuery(sessionId: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.interrupted = true
    active.state.controller.abort()
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    if (mode === 'safe' || mode === 'auto' || mode === 'plan' || mode === 'bypassPermissions') {
      active.state.permissionMode = mode
      active.state.planModeEntered = mode === 'plan'
    }
  }

  async sendQueuedMessage(sessionId: string, message: SDKUserMessageInput): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) {
      throw new Error(`[AI SDK Runtime] 无活跃会话可追加消息: ${sessionId}`)
    }
    active.queuedMessages.push(message)
    active.resolveQueuedMessage?.()
    active.resolveQueuedMessage = undefined
  }

  async cancelQueuedMessage(sessionId: string, messageUuid: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.queuedMessages = active.queuedMessages.filter((message) => message.uuid !== messageUuid)
    active.resolveQueuedMessage?.()
    active.resolveQueuedMessage = undefined
  }

  dispose(): void {
    for (const [sessionId, active] of this.activeSessions) {
      active.state.controller.abort()
      active.cancelled = true
      active.resolveQueuedMessage?.()
      this.activeSessions.delete(sessionId)
    }
  }
}

function createAbortController(parentSignal: AbortSignal | undefined): AbortController {
  const controller = new AbortController()
  if (parentSignal) {
    parentSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller
}

function waitForQueuedMessage(active: ActiveAISDKSession): Promise<void> {
  if (active.queuedMessages.length > 0) return Promise.resolve()
  return new Promise((resolve) => {
    active.resolveQueuedMessage = resolve
  })
}

function createQueuedHistoryMessage(
  prompt: string,
  attachments: AISDKAgentQueryOptions['attachments'],
): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null,
    ...(attachments ? { _attachments: attachments } : {}),
  } as SDKMessage
}
