/**
 * Pi Agent SDK 适配器。
 *
 * v1 目标是接通一条真实 Pi runtime 闭环：Proma 渠道临时注册为 Pi provider/model，
 * Pi 负责 agent loop，Proma 仍负责会话持久化、UI 事件、工具执行与权限决策。
 * Pi 只能调用显式注册的 Proma Tool Bridge，不能直接使用其内置 Shell 或文件工具。
 */

import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentProviderAdapter, AgentQueryInput, McpServerEntry, PromaPermissionMode, SDKMessage } from '@proma/shared'
import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { enrichMessageWithDocuments } from '../agent-runtime/attachment-enrichment'
import { convertPiMessageToSDKMessage, convertSDKMessagesToPiMessages, isAssistantPiMessage } from './pi-message-adapter'
import { registerPiModelFromChannel } from './pi-model-registry'
import { loadPiCodingAgent } from './pi-sdk-loader'
import { createPiToolBridge, type PiCanUseToolCallback } from './pi-tool-bridge'
import type { ToolContext } from '../agent-runtime/types'
import { ElectronRuntimeMcpService, type RuntimeMcpService } from '../agent-runtime/runtime-mcp-service'
import { createPartialMessageCoalescer } from './pi-streaming-control'

export interface PiAgentQueryOptions extends AgentQueryInput {
  /** 系统提示词 */
  systemPrompt?: string
  /** 历史 SDKMessage，用于恢复 Pi in-memory session 上下文 */
  historyMessages?: SDKMessage[]
  /** 当前会话权限模式 */
  permissionMode?: PromaPermissionMode
  /** Proma 统一权限检查回调 */
  canUseTool?: PiCanUseToolCallback
  /** Pi 通过 Proma Bridge 触发的交互能力。 */
  toolContextOverrides?: Pick<ToolContext, 'onEnterPlanMode' | 'onExitPlanMode' | 'setPermissionMode' | 'onAskUser' | 'runSubAgent' | 'onGoalCheckpoint'>
  mcpServers?: Record<string, McpServerEntry>
  workspaceSlug?: string
  /** Proma 工作区的 Skills 目录；直接加载，不复制到 Pi 临时目录。 */
  workspaceSkillsDir?: string
  onMcpAuthRequired?: (payload: { workspaceSlug: string; serverName: string }) => void
  /** Pi 原生运行状态投影到现有 Agent UI。 */
  onAgentEvent?: (event: AgentEvent) => void
}

interface ActivePiSession {
  session: AgentSession
  unsubscribe: () => void
}

interface AsyncQueue<T> {
  push(value: T): void
  close(): void
  fail(error: unknown): void
  next(): Promise<IteratorResult<T>>
}

const PI_PARTIAL_UPDATE_INTERVAL_MS = 50

/**
 * 把 Pi 订阅事件与异步迭代器解耦。
 *
 * Pi 会在一次 prompt 内自行完成多轮「模型 → 工具 → 模型」。不能以某条 toolResult
 * 是否位于 state 末尾判断任务结束；应持续消费 message_end，直到 prompt 真正收束。
 */
function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = []
  const waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = []
  let closed = false
  let failure: unknown

  const flush = (): void => {
    while (waiters.length > 0 && (values.length > 0 || closed || failure !== undefined)) {
      const waiter = waiters.shift()
      if (!waiter) return
      if (values.length > 0) {
        waiter.resolve({ value: values.shift()!, done: false })
      } else if (failure !== undefined) {
        waiter.reject(failure)
        failure = undefined
      } else {
        waiter.resolve({ value: undefined, done: true })
      }
    }
  }

  return {
    push(value) {
      if (closed) return
      values.push(value)
      flush()
    },
    close() {
      closed = true
      flush()
    },
    fail(error) {
      if (closed) return
      failure = error
      closed = true
      flush()
    },
    next() {
      if (values.length > 0) return Promise.resolve({ value: values.shift()!, done: false })
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        return Promise.reject(error)
      }
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise<IteratorResult<T>>((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}

export class PiAgentAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActivePiSession>()
  constructor(private readonly mcpService: RuntimeMcpService = new ElectronRuntimeMcpService()) {}

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const { sessionId, prompt, provider, apiKey, baseUrl, model, cwd, systemPrompt, historyMessages, attachments, permissionMode, canUseTool, toolContextOverrides, mcpServers, workspaceSlug, workspaceSkillsDir, onMcpAuthRequired, onAgentEvent } = input
    if (!provider || !apiKey || !baseUrl || !model || !cwd) {
      throw new Error('Pi Runtime 需要 provider、apiKey、baseUrl、model、cwd')
    }

    const registration = await registerPiModelFromChannel({
      sessionId,
      provider,
      apiKey,
      baseUrl,
      modelId: model,
    })

    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await loadPiCodingAgent()
    let mcpRelease: (() => void) | undefined
    let mcpTools: import('../agent-runtime/types').RuntimeToolDefinition[] = []
    if (mcpServers && workspaceSlug && Object.keys(mcpServers).length > 0) {
      const acquired = await this.mcpService.acquireClientManager({ workspaceSlug, mcpServers, cwd, onMcpAuthRequired })
      mcpRelease = acquired.release
      mcpTools = await acquired.manager.listAllTools()
    }
    const customTools = createPiToolBridge({
      toolContext: {
        cwd,
        sessionId,
        permissionMode,
        ...toolContextOverrides,
      },
      canUseTool,
      mcpTools,
    })
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
      // WebBridge / Computer Use 的截图必须进入模型上下文；blockImages=true
      // 会让 Pi 在工具已成功返回图片后静默丢弃图片本体，表现为“截图没反应”。
      images: { blockImages: false },
    })
    const toolPrompt = customTools
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n')
    const goalGuidance = customTools.some((tool) => tool.name === 'GoalCheckpoint')
      ? '\nWhen the user message states that Goal Runtime is activated, this is an active Goal. Complete the current step and call GoalCheckpoint before ending the turn. Do not claim Goal is unsupported. Use outcome=complete only with concrete evidence; otherwise use continue, waiting, or blocked.'
      : ''
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: registration.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: false,
      additionalSkillPaths: workspaceSkillsDir ? [workspaceSkillsDir] : [],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // 以 override 固定 Proma 的系统提示词边界，避免 Pi 资源加载过程中隐式追加或
      // 覆盖工具约束；所有模型可见工具均来自 Proma Bridge。
      systemPromptOverride: () => `${systemPrompt ?? ''}\n\n<pi_proma_tools>\n只能使用以下完全一致的工具名称；不得声称工具缺失，也不得调用小写 Pi 内置工具。\n\n网页操作是强制顺序：当用户消息含有 URL 时，第一个网页工具必须是 WebBridgeNavigate({ url })。只有它成功后，才能调用 WebBridgeSnapshot、WebBridgeScreenshot、WebBridgeClick、WebBridgeType 或 WebBridgeScroll。尤其是“打开网页并截图/理解内容”任务，绝不能先调用 WebBridgeScreenshot；若尚未导航，立即调用 WebBridgeNavigate，而不是结束回答。快照返回后，点击或输入必须使用其中的 element_id。除非实际工具结果报错，否则不得声称工具缺失。${goalGuidance}\n${toolPrompt}\n</pi_proma_tools>`,
    })
    await resourceLoader.reload()

    const { session } = await createAgentSession({
      cwd,
      agentDir: registration.agentDir,
      modelRuntime: registration.modelRuntime,
      model: registration.model,
      thinkingLevel: 'off',
      // 禁用 Pi 内置文件/Shell 工具，但保留 customTools。Proma Bridge 是唯一工具
      // 执行入口，统一经过权限策略、工作区边界和审计。
      noTools: 'builtin',
      customTools,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    })
    // 网页导航、快照与点击必须按模型决策顺序执行，禁止 Pi 并发交叉多个有状态操作。
    session.agent.toolExecution = 'sequential'

    if (historyMessages && historyMessages.length > 0) {
      session.state.messages = convertSDKMessagesToPiMessages(historyMessages)
    }

    // 同一 prompt 内由 Pi 原生驱动完整工具循环；逐条投影 message_end，不能等
    // agent_end 后再从 state 回放，否则工具结果和最终总结会在 UI 中表现为断流。
    const queue = createAsyncQueue<SDKMessage>()
    let assistantUuid: string | undefined
    let deferredRetryError: SDKMessage | undefined
    const assistantUuidFor = (): string => {
      assistantUuid ??= randomUUID()
      return assistantUuid
    }
    const resetAssistantUuid = (): void => { assistantUuid = undefined }
    const partialAssistantCoalescer = createPartialMessageCoalescer<PiAssistantMessage>((message) => {
      const converted = convertPiMessageToSDKMessage(message, sessionId, model, {
        final: false,
        uuid: assistantUuidFor(),
      })
      if (converted) queue.push(converted)
    }, PI_PARTIAL_UPDATE_INTERVAL_MS)
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_update' && isAssistantPiMessage(event.message)) {
        // 原生 retry 前的 error assistant 只是暂态；不能先显示再等待 agent_end.willRetry。
        if (event.message.stopReason === 'error') return
        partialAssistantCoalescer.schedule(event.message)
        return
      }
      if (event.type === 'message_end') {
        partialAssistantCoalescer.flush()
        const message = convertPiMessageToSDKMessage(event.message, sessionId, model, {
          final: true,
          ...(isAssistantPiMessage(event.message) ? { uuid: assistantUuidFor() } : {}),
        })
        const isRetryableError = isAssistantPiMessage(event.message) && event.message.stopReason === 'error'
        if (isRetryableError && message) {
          // Pi 会在 agent_end.willRetry 确认前先发送失败 assistant；暂不把它显示成终态。
          deferredRetryError = message
        } else if (message) {
          queue.push(message)
        }
        if (isAssistantPiMessage(event.message) && !isRetryableError) resetAssistantUuid()
        return
      }
      if (event.type === 'agent_end') {
        if (!event.willRetry && deferredRetryError) queue.push(deferredRetryError)
        deferredRetryError = undefined
        if (!event.willRetry) resetAssistantUuid()
        return
      }
      if (event.type === 'auto_retry_start') {
        onAgentEvent?.({
          type: 'retrying',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delaySeconds: event.delayMs / 1_000,
          reason: event.errorMessage,
        })
        return
      }
      if (event.type === 'auto_retry_end') {
        if (event.success) onAgentEvent?.({ type: 'retry_cleared' })
        else onAgentEvent?.({
          type: 'retry_failed',
          finalAttempt: {
            attempt: event.attempt,
            timestamp: Date.now(),
            reason: event.finalError ?? 'Pi 原生重试失败',
            errorMessage: event.finalError ?? 'Pi 原生重试失败',
            delaySeconds: 0,
          },
        })
        return
      }
      if (event.type === 'tool_execution_update') {
        onAgentEvent?.({ type: 'task_progress', toolUseId: event.toolCallId })
      }
    })
    this.activeSessions.set(sessionId, { session, unsubscribe })

    try {
      const enrichedPrompt = await enrichMessageWithDocuments(prompt, attachments)
      void session.prompt(enrichedPrompt, { expandPromptTemplates: false })
        .then(() => queue.close())
        .catch((error: unknown) => queue.fail(error))
      while (true) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      partialAssistantCoalescer.dispose()
      this.releaseSession(sessionId)
      mcpRelease?.()
    }
  }

  abort(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    void active.session.abort().catch((error: unknown) => {
      console.error('[Pi Runtime] 中止会话失败:', error)
    })
    this.releaseSession(sessionId)
  }

  dispose(): void {
    for (const sessionId of this.activeSessions.keys()) {
      this.releaseSession(sessionId)
    }
  }

  private releaseSession(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    this.activeSessions.delete(sessionId)
    active.unsubscribe()
    active.session.dispose()
  }
}
