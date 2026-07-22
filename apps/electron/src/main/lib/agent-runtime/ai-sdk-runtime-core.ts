/**
 * AI SDK Agent runtime core。
 *
 * 该层只负责 AI SDK streamText 调用、工具包装、权限兜底与 SDKMessage 转换。
 * Electron 侧 adapter 负责渠道、MCP 获取、会话生命周期和持久化编排。
 */

import type {
  AgentEvent,
  AgentProviderProtocol,
  FileAttachment,
  PromaPermissionMode,
  ProviderType,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKResultMessage,
  SDKUserContentBlock,
  SDKUserMessage,
} from '@proma/shared'
import { resolveAgentRuntimeBaseUrl } from '@proma/shared'
import { normalizeAgentRuntimeError } from '@proma/shared/utils'
import {
  AISDKStreamStepAccumulator,
  createAgentAISDKModel,
  type AISDKStreamStepSnapshot,
} from '@proma/core/providers/ai-sdk-bridge'
import type { LanguageModel, LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from 'ai'
import { isStepCount, jsonSchema, streamText, tool } from 'ai'
import { isTransientNetworkError } from '../error-patterns'
import { enrichHistoryWithDocuments, enrichMessageWithDocuments } from './attachment-enrichment'
import { buildAgentSystemPrompt, sdkMessagesToChatMessages } from './prompt-builder'
import { ASK_USER_QUESTION_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from './tool-registry'
import type { RuntimeToolDefinition } from './types'

export interface AISDKRuntimeSessionState {
  controller: AbortController
  permissionMode: PromaPermissionMode
  planModeEntered: boolean
}

export interface AISDKToolPermissionResult {
  allowed: boolean
  message?: string
}

export type AISDKCanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<AISDKToolPermissionResult>

export interface AISDKToolExecutionState {
  sessionId: string
  cwd: string
  signal: AbortSignal
  activeSession: AISDKRuntimeSessionState
  canUseTool?: AISDKCanUseToolCallback
  onEnterPlanMode?: () => void
  onExitPlanMode?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ behavior: 'allow'; targetMode?: PromaPermissionMode } | { behavior: 'deny'; message: string }>
  onAskUser?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<{ behavior: 'allow'; answers: Record<string, string> } | { behavior: 'deny'; message: string }>
  runSubAgent?: import('./types').ToolContext['runSubAgent']
  mcpManager?: import('./mcp-client').McpClientManager
}

export interface AISDKRuntimeStreamInput {
  model: LanguageModel
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  maxTurns: number
  maxRetries: number
  signal: AbortSignal
  provider?: ProviderType
  modelId?: string
  onAgentEvent?: (event: AgentEvent) => void
}

export interface AISDKRuntimeStreamResult {
  result: ReturnType<typeof streamText>
  streamedSteps: AISDKStreamStepSnapshot[]
}

export interface AISDKAgentTurnInput {
  sessionId: string
  prompt: string
  modelId: string
  provider: ProviderType
  protocol: AgentProviderProtocol
  apiKey: string
  baseUrl: string
  cwd: string
  runtimeTools: RuntimeToolDefinition[]
  activeSession: AISDKRuntimeSessionState
  maxTurns: number
  maxRetries: number
  historyMessages?: SDKMessage[]
  attachments?: FileAttachment[]
  systemPrompt?: string
  onAgentEvent?: (event: AgentEvent) => void
  canUseTool?: AISDKCanUseToolCallback
  onEnterPlanMode?: () => void
  onExitPlanMode?: AISDKToolExecutionState['onExitPlanMode']
  onAskUser?: AISDKToolExecutionState['onAskUser']
  runSubAgent?: AISDKToolExecutionState['runSubAgent']
  mcpManager?: AISDKToolExecutionState['mcpManager']
}

export interface ExecutedAISDKToolResult {
  content: string
  isError?: boolean
  imageData?: Array<{ mediaType: string; data: string }>
}

interface SDKMessageStepSnapshot {
  text: string
  reasoningText?: string
  toolCalls: ReadonlyArray<{
    toolCallId: string
    toolName: string
    input: unknown
  }>
  toolResults: ReadonlyArray<{
    toolCallId: string
    toolName: string
    input: unknown
    output: unknown
  }>
  finishReason: string
}

type RuntimeToolJsonSchema = RuntimeToolDefinition['parameters']

export class AISDKRuntimeCore {
  async runAgentTurn(input: AISDKAgentTurnInput): Promise<SDKMessage[]> {
    const modelInstance = createAgentAISDKModel({
      provider: input.provider,
      protocol: input.protocol,
      providerName: `proma-${input.provider}`,
      apiKey: input.apiKey,
      baseUrl: resolveAgentRuntimeBaseUrl(input.provider, 'ai-sdk', input.baseUrl),
      modelId: input.modelId,
    })
    const effectiveSystemPrompt = buildAgentSystemPrompt(input.systemPrompt, input.cwd)
    const history = await enrichHistoryWithDocuments(
      input.historyMessages ? sdkMessagesToChatMessages(input.historyMessages) : [],
    )
    const enrichedPrompt = await enrichMessageWithDocuments(input.prompt, input.attachments)
    const messages = buildAISDKModelMessages(history, enrichedPrompt)
    const toolSet = this.createAISDKTools(input.runtimeTools, {
      sessionId: input.sessionId,
      cwd: input.cwd,
      signal: input.activeSession.controller.signal,
      activeSession: input.activeSession,
      canUseTool: input.canUseTool,
      onEnterPlanMode: input.onEnterPlanMode,
      onExitPlanMode: input.onExitPlanMode,
      onAskUser: input.onAskUser,
      runSubAgent: input.runSubAgent,
      mcpManager: input.mcpManager,
    })

    const streamRun = await this.runStreamTextWithRetry({
      model: modelInstance,
      system: effectiveSystemPrompt,
      messages,
      tools: toolSet,
      maxTurns: input.maxTurns,
      maxRetries: input.maxRetries,
      signal: input.activeSession.controller.signal,
      provider: input.provider,
      modelId: input.modelId,
      onAgentEvent: input.onAgentEvent,
    })

    const steps = streamRun.streamedSteps.length > 0
      ? streamRun.streamedSteps
      : await streamRun.result.steps
    const sdkMessages = buildAISDKMessagesFromSteps(steps, input.sessionId, input.modelId)
    const usage = await streamRun.result.usage
    const resultMessage: SDKResultMessage = {
      type: 'result',
      subtype: 'success',
      usage: toAISDKResultUsage(usage),
      session_id: input.sessionId,
    }
    return [...sdkMessages, resultMessage as unknown as SDKMessage]
  }

  async runStreamTextWithRetry(input: AISDKRuntimeStreamInput): Promise<AISDKRuntimeStreamResult> {
    let attempt = 0
    let lastError: unknown
    while (attempt <= input.maxRetries) {
      let attemptHadLiveEvents = false
      try {
        const result = streamText({
          model: input.model,
          system: input.system,
          messages: input.messages,
          tools: input.tools,
          stopWhen: isStepCount(input.maxTurns),
          abortSignal: input.signal,
        })
        const accumulator = new AISDKStreamStepAccumulator()
        const streamedSteps: AISDKStreamStepSnapshot[] = []
        for await (const part of result.stream) {
          streamedSteps.push(...accumulator.consume(part))
          const events = aiSDKStreamPartToAgentEvents(part)
          if (events.length > 0) {
            attemptHadLiveEvents = true
          }
          for (const event of events) {
            input.onAgentEvent?.(event)
          }
        }
        return { result, streamedSteps }
      } catch (error) {
        lastError = error
        // 用户停止或追加消息触发的中断由 adapter 决定是否续跑；这里不能上报错误，
        // 否则渲染层会把正常的下一轮 turn 误标记为失败。
        if (input.signal.aborted) {
          throw error
        }
        if (
          attemptHadLiveEvents ||
          !isTransientNetworkError(getErrorMessage(error)) ||
          attempt >= input.maxRetries
        ) {
          input.onAgentEvent?.({
            type: 'typed_error',
            error: normalizeAgentRuntimeError({
              runtime: 'ai-sdk',
              provider: input.provider,
              model: input.modelId,
              error,
            }),
          })
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

  createAISDKTools(tools: RuntimeToolDefinition[], state: AISDKToolExecutionState): ToolSet {
    const toolSet: ToolSet = {}
    for (const runtimeTool of tools) {
      toolSet[runtimeTool.name] = tool({
        description: runtimeTool.description,
        inputSchema: jsonSchema<Record<string, unknown>>(runtimeTool.parameters as RuntimeToolJsonSchema),
        execute: async (args: Record<string, unknown>, options): Promise<ExecutedAISDKToolResult> => {
          return this.executeRuntimeTool(runtimeTool, args, {
            ...state,
            signal: options.abortSignal ?? state.signal,
          })
        },
        toModelOutput: ({ output }) => output.imageData?.length
          ? {
              type: 'content' as const,
              value: [
                { type: 'text' as const, text: output.content },
                ...output.imageData.map((image) => ({
                  type: 'file' as const,
                  mediaType: image.mediaType,
                  data: { type: 'data' as const, data: Buffer.from(image.data, 'base64') },
                })),
              ],
            }
          : { type: 'text' as const, value: output.isError ? `[错误] ${output.content}` : output.content },
      })
    }
    return toolSet
  }

  private async executeRuntimeTool(
    runtimeTool: RuntimeToolDefinition,
    args: Record<string, unknown>,
    state: AISDKToolExecutionState,
  ): Promise<ExecutedAISDKToolResult> {
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
      return { content: result.content, isError: result.isError, imageData: result.imageData }
    } catch (error) {
      return { content: `工具执行失败: ${getErrorMessage(error)}`, isError: true }
    }
  }

  private async checkToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    state: AISDKToolExecutionState,
  ): Promise<AISDKToolPermissionResult> {
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

export function buildAISDKModelMessages(
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

export function buildAISDKMessagesFromSteps(
  steps: readonly SDKMessageStepSnapshot[],
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

export function toAISDKResultUsage(usage: LanguageModelUsage): NonNullable<SDKResultMessage['usage']> {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens,
    cache_creation_input_tokens: usage.inputTokenDetails.cacheWriteTokens,
  }
}

function aiSDKStreamPartToAgentEvents(part: TextStreamPart<ToolSet>): AgentEvent[] {
  switch (part.type) {
    case 'text-delta':
      return [{ type: 'text_delta', text: part.text }]
    case 'tool-input-start':
      return [{
        type: 'tool_start',
        toolName: part.toolName,
        toolUseId: part.id,
        input: {},
      }]
    case 'tool-call':
      return [{
        type: 'tool_start',
        toolName: part.toolName,
        toolUseId: part.toolCallId,
        input: normalizeToolInput(part.input),
      }]
    case 'tool-result':
      return [{
        type: 'tool_result',
        toolName: part.toolName,
        toolUseId: part.toolCallId,
        input: normalizeToolInput(part.input),
        result: normalizeToolOutput(part.output),
        isError: isErrorToolOutput(part.output),
      }]
    case 'tool-error':
      return [{
        type: 'tool_result',
        toolName: part.toolName,
        toolUseId: part.toolCallId,
        input: normalizeToolInput(part.input),
        result: getErrorMessage(part.error),
        isError: true,
      }]
    case 'finish-step':
      return [{ type: 'usage_update', usage: toAgentEventUsage(part.usage) }]
    default:
      return []
  }
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

function isExecutedToolResult(output: unknown): output is ExecutedAISDKToolResult {
  return typeof output === 'object' && output !== null && 'content' in output
}

function toAgentEventUsage(usage: LanguageModelUsage): NonNullable<Extract<AgentEvent, { type: 'usage_update' }>['usage']> {
  return {
    inputTokens: (usage.inputTokens ?? 0)
      + (usage.inputTokenDetails.cacheReadTokens ?? 0)
      + (usage.inputTokenDetails.cacheWriteTokens ?? 0),
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheCreationTokens: usage.inputTokenDetails.cacheWriteTokens,
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
