/**
 * Vercel AI SDK Agent Runtime 适配器。
 *
 * 目标是让未来 Web/Server runtime 可以复用同一套模型与工具协议；当前先接入
 * OpenAI-compatible provider，工具执行和权限仍复用 Proma 自己的 runtime 工具层。
 */

import type {
  AgentProviderAdapter,
  AgentQueryInput,
  FileAttachment,
  McpServerEntry,
  PromaPermissionMode,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKResultMessage,
  SDKUserContentBlock,
  SDKUserMessage,
} from '@proma/shared'
import type { LanguageModelUsage, ModelMessage, StepResult, ToolSet } from 'ai'
import { isStepCount, jsonSchema, streamText, tool } from 'ai'
import type { ToolCall, ToolResult } from '@proma/core'
import { createOpenAICompatibleAISDKModel } from '@proma/core/providers/ai-sdk-bridge'
import { getAgentProviderProtocol, resolveAgentRuntimeBaseUrl } from '@proma/shared'
import { createCoreTools, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME } from '../agent-runtime/tool-registry'
import { acquireMcpClientManager } from '../agent-runtime/mcp-client-cache'
import type { RuntimeToolDefinition } from '../agent-runtime/types'
import { buildAgentSystemPrompt, sdkMessagesToChatMessages } from '../agent-runtime/prompt-builder'
import { enrichHistoryWithDocuments, enrichMessageWithDocuments } from '../agent-runtime/attachment-enrichment'
import { isTransientNetworkError } from '../error-patterns'
import type { CanUseToolCallback, ToolPermissionResult } from './provider-agnostic-agent-adapter'

export interface AISDKAgentQueryOptions extends AgentQueryInput {
  /** 最大工具调用 step 数 */
  maxTurns?: number
  /** 系统提示词 */
  systemPrompt?: string
  /** 权限模式 */
  permissionMode?: PromaPermissionMode
  /** 自定义权限检查回调 */
  canUseTool?: CanUseToolCallback
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
}

interface ActiveAISDKSession {
  controller: AbortController
  permissionMode: PromaPermissionMode
  planModeEntered: boolean
}

interface ToolExecutionState {
  sessionId: string
  cwd: string
  signal: AbortSignal
  activeSession: ActiveAISDKSession
  canUseTool?: CanUseToolCallback
  onEnterPlanMode?: () => void
  onExitPlanMode?: AISDKAgentQueryOptions['onExitPlanMode']
  onAskUser?: AISDKAgentQueryOptions['onAskUser']
  runSubAgent?: AISDKAgentQueryOptions['runSubAgent']
  mcpManager?: import('../agent-runtime/mcp-client').McpClientManager
}

interface ExecutedToolResult {
  content: string
  isError?: boolean
}

type RuntimeToolJsonSchema = RuntimeToolDefinition['parameters']

export class AISDKAgentAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActiveAISDKSession>()

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

    const protocol = getAgentProviderProtocol(provider, 'ai-sdk')
    if (protocol !== 'openai-chat') {
      throw new Error(`AI SDK Runtime 暂不支持 ${provider} 的 ${protocol} 协议`)
    }

    const controller = new AbortController()
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const activeSession: ActiveAISDKSession = {
      controller,
      permissionMode: input.permissionMode ?? 'auto',
      planModeEntered: input.permissionMode === 'plan',
    }
    this.activeSessions.set(sessionId, activeSession)

    let mcpRelease: (() => void) | undefined
    try {
      const tools = [...createCoreTools()]
      let mcpManager: import('../agent-runtime/mcp-client').McpClientManager | undefined
      if (mcpServers && Object.keys(mcpServers).length > 0 && workspaceSlug) {
        try {
          const acquired = await acquireMcpClientManager(workspaceSlug, mcpServers, cwd, { onMcpAuthRequired })
          mcpManager = acquired.manager
          mcpRelease = acquired.release
          tools.push(...await mcpManager.listAllTools(controller.signal))
          console.log(`[AI SDK Runtime] 已加载 ${tools.length} 个工具（含 MCP）`)
        } catch (err) {
          console.error('[AI SDK Runtime] 加载 MCP 工具失败，将继续使用核心工具:', err)
        }
      }

      const modelInstance = createOpenAICompatibleAISDKModel({
        providerName: `proma-${provider}`,
        apiKey,
        baseUrl: resolveAgentRuntimeBaseUrl(provider, 'ai-sdk', baseUrl),
        modelId: model,
      })
      const effectiveSystemPrompt = buildAgentSystemPrompt(input.systemPrompt, cwd)
      const history = await enrichHistoryWithDocuments(
        input.historyMessages ? sdkMessagesToChatMessages(input.historyMessages) : [],
      )
      const enrichedPrompt = await enrichMessageWithDocuments(prompt, attachments)
      const messages = buildModelMessages(history, enrichedPrompt)
      const toolSet = this.createAISDKTools(tools, {
        sessionId,
        cwd,
        signal: controller.signal,
        activeSession,
        canUseTool: input.canUseTool,
        onEnterPlanMode: input.onEnterPlanMode,
        onExitPlanMode: input.onExitPlanMode,
        onAskUser: input.onAskUser,
        runSubAgent: input.runSubAgent,
        mcpManager,
      })

      const result = await this.runStreamTextWithRetry({
        model: modelInstance,
        system: effectiveSystemPrompt,
        messages,
        tools: toolSet,
        maxTurns,
        maxRetries: input.maxRetries ?? 2,
        signal: controller.signal,
      })

      const steps = await result.steps
      for (const message of buildSDKMessagesFromSteps(steps, sessionId, model)) {
        yield message
      }

      const usage = await result.usage
      const resultMessage: SDKResultMessage = {
        type: 'result',
        subtype: 'success',
        usage: toSDKUsage(usage),
        session_id: sessionId,
      }
      yield resultMessage as unknown as SDKMessage
    } finally {
      this.activeSessions.delete(sessionId)
      mcpRelease?.()
    }
  }

  abort(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.controller.abort()
    this.activeSessions.delete(sessionId)
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    if (mode === 'safe' || mode === 'auto' || mode === 'plan' || mode === 'bypassPermissions') {
      active.permissionMode = mode
      active.planModeEntered = mode === 'plan'
    }
  }

  dispose(): void {
    for (const [sessionId, active] of this.activeSessions) {
      active.controller.abort()
      this.activeSessions.delete(sessionId)
    }
  }

  private async runStreamTextWithRetry(input: {
    model: Parameters<typeof streamText>[0]['model']
    system: string
    messages: ModelMessage[]
    tools: ToolSet
    maxTurns: number
    maxRetries: number
    signal: AbortSignal
  }): Promise<ReturnType<typeof streamText>> {
    let attempt = 0
    let lastError: unknown
    while (attempt <= input.maxRetries) {
      try {
        const result = streamText({
          model: input.model,
          system: input.system,
          messages: input.messages,
          tools: input.tools,
          stopWhen: isStepCount(input.maxTurns),
          abortSignal: input.signal,
        })
        for await (const _part of result.stream) {
          // 消费 stream 以驱动工具执行；当前 UI 仍由完整 SDKMessage 刷新。
        }
        return result
      } catch (error) {
        lastError = error
        if (input.signal.aborted || !isTransientNetworkError(getErrorMessage(error)) || attempt >= input.maxRetries) {
          throw error
        }
        attempt++
        const delayMs = 1000 * attempt
        console.warn(`[AI SDK Runtime] 第 ${attempt} 次重试 streamText（${delayMs}ms）: ${getErrorMessage(error)}`)
        await sleep(delayMs, input.signal)
      }
    }
    throw lastError
  }

  private createAISDKTools(tools: RuntimeToolDefinition[], state: ToolExecutionState): ToolSet {
    const toolSet: ToolSet = {}
    for (const runtimeTool of tools) {
      toolSet[runtimeTool.name] = tool({
        description: runtimeTool.description,
        inputSchema: jsonSchema<Record<string, unknown>>(runtimeTool.parameters as RuntimeToolJsonSchema),
        execute: async (args: Record<string, unknown>, options): Promise<ExecutedToolResult> => {
          return this.executeRuntimeTool(runtimeTool, args, {
            ...state,
            signal: options.abortSignal ?? state.signal,
          })
        },
        toModelOutput: ({ output }) => ({
          type: 'text',
          value: output.isError ? `[错误] ${output.content}` : output.content,
        }),
      })
    }
    return toolSet
  }

  private async executeRuntimeTool(
    runtimeTool: RuntimeToolDefinition,
    args: Record<string, unknown>,
    state: ToolExecutionState,
  ): Promise<ExecutedToolResult> {
    if (runtimeTool.name === ENTER_PLAN_MODE_TOOL_NAME) {
      state.activeSession.planModeEntered = true
      state.onEnterPlanMode?.()
      return { content: '已进入 Plan 模式' }
    }

    if (runtimeTool.name === EXIT_PLAN_MODE_TOOL_NAME) {
      if (!state.onExitPlanMode) {
        state.activeSession.planModeEntered = false
        return { content: '已退出 Plan 模式' }
      }
      const result = await state.onExitPlanMode(args, state.signal)
      if (result.behavior === 'deny') {
        return { content: result.message || '用户拒绝了计划', isError: true }
      }
      if (result.targetMode) {
        state.activeSession.permissionMode = result.targetMode
      }
      state.activeSession.planModeEntered = false
      return { content: `已退出 Plan 模式，切换到 ${result.targetMode ?? '默认'} 模式` }
    }

    if (runtimeTool.name === ASK_USER_QUESTION_TOOL_NAME) {
      if (!state.onAskUser) {
        return { content: '当前 Runtime 未配置 AskUser 回调', isError: true }
      }
      const result = await state.onAskUser(args, state.signal)
      if (result.behavior === 'deny') {
        return { content: result.message || '用户拒绝回答', isError: true }
      }
      const answerBlocks = Object.entries(result.answers)
        .map(([q, a]) => `Q: ${q}\nA: ${a}`)
        .join('\n\n')
      return {
        content: `用户回答如下：\n\n${answerBlocks}\n\nanswers JSON: ${JSON.stringify(result.answers)}`,
      }
    }

    const permission = await this.checkToolPermission(runtimeTool.name, args, state)
    if (!permission.allowed) {
      return { content: permission.message || `权限被拒绝：${runtimeTool.name}`, isError: true }
    }

    try {
      const result = await runtimeTool.execute(args, {
        cwd: state.cwd,
        sessionId: state.sessionId,
        abortSignal: state.signal,
        permissionMode: state.activeSession.permissionMode,
        planModeEntered: state.activeSession.planModeEntered,
        onEnterPlanMode: state.onEnterPlanMode,
        onExitPlanMode: state.onExitPlanMode,
        setPermissionMode: (mode) => {
          state.activeSession.permissionMode = mode
          state.activeSession.planModeEntered = false
        },
        onAskUser: state.onAskUser,
        runSubAgent: state.runSubAgent,
        mcpManager: state.mcpManager,
      })
      return { content: result.content, isError: result.isError }
    } catch (error) {
      return { content: `工具执行失败: ${getErrorMessage(error)}`, isError: true }
    }
  }

  private async checkToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    state: ToolExecutionState,
  ): Promise<ToolPermissionResult> {
    if (state.activeSession.permissionMode === 'bypassPermissions') {
      return { allowed: true }
    }

    if (state.activeSession.permissionMode === 'safe') {
      const safeAllowedTools = new Set([
        'Read',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'TodoRead',
        'TaskOutput',
        'TaskList',
        'TaskGet',
        'ListMcpResourcesTool',
        'ReadMcpResourceTool',
        ASK_USER_QUESTION_TOOL_NAME,
      ])
      if (safeAllowedTools.has(toolName)) return { allowed: true }
      if (toolName === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : ''
        if (isBashCommandReadOnly(command)) return { allowed: true }
      }
      return { allowed: false, message: '安全模式下不允许执行写操作，请切换到自动审批或完全自动模式' }
    }

    if (state.activeSession.permissionMode === 'plan' || state.activeSession.planModeEntered) {
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
      if (planAllowedTools.has(toolName)) return { allowed: true }
      if (toolName === 'Write' || toolName === 'Edit') {
        const filePath = typeof input.file_path === 'string' ? input.file_path : ''
        if (filePath.toLowerCase().endsWith('.md')) return { allowed: true }
      }
      if (toolName === 'Bash') {
        const command = typeof input.command === 'string' ? input.command : ''
        if (isBashCommandReadOnly(command)) return { allowed: true }
        return { allowed: false, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
      }
      if (toolName.startsWith('mcp__')) return { allowed: true }
      return { allowed: false, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
    }

    if (state.canUseTool) {
      return state.canUseTool(toolName, input, state.signal)
    }

    const readOnlyTools = new Set(['Read', 'Grep'])
    if (readOnlyTools.has(toolName)) return { allowed: true }
    return {
      allowed: false,
      message: `${toolName} 需要用户授权，但当前未配置权限回调。请在设置中将权限模式设为“允许所有”或启用交互式权限。`,
    }
  }
}

function buildModelMessages(
  history: Array<{ role: string; content: string }>,
  currentPrompt: string,
): ModelMessage[] {
  return [
    ...history
      .filter((msg): msg is { role: 'user' | 'assistant'; content: string } => msg.role === 'user' || msg.role === 'assistant')
      .map((msg): ModelMessage => ({ role: msg.role, content: msg.content })),
    { role: 'user', content: currentPrompt },
  ]
}

function buildSDKMessagesFromSteps(
  steps: StepResult<ToolSet>[],
  sessionId: string,
  model?: string,
): SDKMessage[] {
  const messages: SDKMessage[] = []
  for (const step of steps) {
    const assistantBlocks: SDKContentBlock[] = []
    if (step.reasoningText) {
      assistantBlocks.push({ type: 'thinking', thinking: step.reasoningText } as unknown as SDKContentBlock)
    }
    if (step.text) {
      assistantBlocks.push({ type: 'text', text: step.text })
    }
    for (const call of step.toolCalls) {
      assistantBlocks.push({
        type: 'tool_use',
        id: call.toolCallId,
        name: call.toolName,
        input: normalizeToolInput(call.input),
      } as unknown as SDKContentBlock)
    }
    if (assistantBlocks.length > 0) {
      const assistantMessage: SDKAssistantMessage = {
        type: 'assistant',
        message: {
          content: assistantBlocks,
          model,
          stop_reason: step.toolCalls.length > 0 ? 'tool_use' : step.finishReason,
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      }
      messages.push(assistantMessage as unknown as SDKMessage)
    }

    if (step.toolResults.length > 0) {
      const toolResultBlocks = step.toolResults.map((result): SDKUserContentBlock => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: normalizeToolOutput(result.output),
        is_error: isErrorToolOutput(result.output),
      } as unknown as SDKUserContentBlock))
      const toolResultMessage: SDKUserMessage = {
        type: 'user',
        message: { content: toolResultBlocks },
        parent_tool_use_id: null,
        session_id: sessionId,
      }
      messages.push(toolResultMessage as unknown as SDKMessage)
    }
  }
  return messages
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input }
}

function normalizeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (isExecutedToolResult(output)) return output.content
  return JSON.stringify(output)
}

function isErrorToolOutput(output: unknown): boolean {
  return isExecutedToolResult(output) && output.isError === true
}

function isExecutedToolResult(output: unknown): output is ExecutedToolResult {
  return typeof output === 'object' && output !== null && 'content' in output
}

function toSDKUsage(usage: LanguageModelUsage): NonNullable<SDKResultMessage['usage']> {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens,
    cache_creation_input_tokens: usage.inputTokenDetails.cacheWriteTokens,
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error) || '未知错误'
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

function isBashCommandReadOnly(command: string): boolean {
  if (/(?<![0-9&])>/.test(command)) return false
  if (/\b(rm|rmdir)\s/.test(command)) return false
  if (/\bsed\s+[^|&;]*-i/.test(command)) return false
  if (/\b(chmod|chown|chattr|truncate)\s/.test(command)) return false
  if (/\b(mv|cp)\s/.test(command)) return false
  if (/\b(mkdir|touch|mktemp)\s/.test(command)) return false
  if (/\b(npm|pnpm|yarn|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|link|unlink)\b/.test(command)) return false
  if (/\bpip[23]?\s+(install|uninstall|upgrade)\b/.test(command)) return false
  if (/\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|purge|uninstall|upgrade)\b/.test(command)) return false
  if (/\bgit\s+(commit|push|checkout\s+-[bB]|branch\s+-[mMdD]|merge\b|rebase\b|reset\b|stash\s+(drop|pop)\b|add\b|apply\b|cherry-pick\b)/.test(command)) return false
  if (/\b(kill|killall|pkill)\s/.test(command)) return false
  if (/\b(node|python[23]?|ruby|perl|php)\s+[^-]/.test(command)) return false
  return true
}
