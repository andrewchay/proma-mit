/**
 * Pi Agent SDK 适配器。
 *
 * v1 目标是接通一条真实 Pi runtime 闭环：Proma 渠道临时注册为 Pi provider/model，
 * Pi 负责 agent loop，Proma 仍负责会话持久化、UI 事件、工具执行与权限决策。
 * Pi 只能调用显式注册的 Proma Tool Bridge，不能直接使用其内置 Shell 或文件工具。
 */

import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import type { AgentEvent, AgentProviderAdapter, AgentQueryInput, AgentThinkingLevel, McpServerEntry, PromaPermissionMode, SDKMessage } from '@proma/shared'
import { calculatePiAutoCompactionReserveTokens, PI_DEFAULT_CONTEXT_WINDOW } from '@proma/shared'
import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai'
import type { AgentSession, AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createPromaSkillsOverride, preparePromptWithPromaSkills } from './pi-skill-loader'
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
  workspaceId?: string
  /** Proma 工作区的 Skills 目录；直接加载，不复制到 Pi 临时目录。 */
  workspaceSkillsDir?: string
  /** 用户通过命令菜单/引用面板显式选择的 Skill slug 列表；优先于 prompt 内 /skill:xxx 提取 */
  skillMentions?: string[]
  onMcpAuthRequired?: (payload: { workspaceSlug: string; serverName: string }) => void
  /** Pi 原生运行状态投影到现有 Agent UI。 */
  onAgentEvent?: (event: AgentEvent) => void
  /** 本次发送的触发来源：用户 / 定时任务 / 协作子会话 */
  triggeredBy?: 'user' | 'automation' | 'delegation'
  /** 是否为协作子会话（由委派创建或处于协作链）；子会话不注入 collaboration 工具 */
  isDelegationSession?: boolean
  /** 会话级思考级别（Pi runtime 支持）；缺省 off，仅 reasoning 模型生效 */
  thinkingLevel?: AgentThinkingLevel
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

// ===== 上下文压缩（借鉴上游 Proma #1246） =====

/** 自动压缩续跑上限：压缩后自动继续原任务的最大次数 */
const MAX_AUTOMATIC_COMPACTION_CONTINUATIONS = 20

/** 压缩完成后自动继续原任务的提示词 */
const PI_COMPACTION_CONTINUATION_PROMPT = `<proma_compaction_continuation>
上下文已压缩。若原任务尚未完成，请基于已持久化的状态继续完成原任务；若已全部完成，简要确认即可。
</proma_compaction_continuation>`

/**
 * 当前 Agent 回合结束后执行 Pi 原生 session.compact()。
 * 若没有可压缩内容（nothing to compact / already compacted），投影一条 noop 状态消息。
 */
async function compactCurrentSessionAfterTurn(
  session: Pick<AgentSession, 'compact'>,
  sessionId: string,
  onNoop: (message: SDKMessage) => void,
): Promise<'compacted' | 'noop'> {
  try {
    await session.compact()
    return 'compacted'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/nothing to compact|already compacted/i.test(message)) throw error
    onNoop({
      type: 'system',
      subtype: 'status',
      session_id: sessionId,
      compact_result: 'noop',
      message: /already compacted/i.test(message)
        ? '当前上下文已经压缩过，无需重复压缩。'
        : '当前上下文较小，暂时无需压缩。',
    } as unknown as SDKMessage)
    return 'noop'
  }
}

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
    const { sessionId, prompt, provider, apiKey, baseUrl, model, cwd, systemPrompt, historyMessages, attachments, permissionMode, canUseTool, toolContextOverrides, mcpServers, workspaceSlug, workspaceId, workspaceSkillsDir, onMcpAuthRequired, onAgentEvent, triggeredBy, isDelegationSession, thinkingLevel } = input
    if (!provider || !apiKey || !baseUrl || !model || !cwd) {
      throw new Error('Pi Runtime 需要 provider、apiKey、baseUrl、model、cwd')
    }

    // 上下文压缩状态：CompactContext 工具请求压缩，当前回合结束后执行 session.compact() 并自动续跑。
    let compactContextRequested = false
    let automaticCompactionContinuations = 0

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
    // 内置 collaboration 协作子会话工具：仅在绑定项目的父会话可用
    const collaborationAvailable = !!workspaceId && !!input.channelId && !isDelegationSession
    if (collaborationAvailable) {
      try {
        const { buildPiCollaborationTools } = await import('../agent-collaboration-tools')
        const piSdk = await loadPiCodingAgent()
        const collaborationTools = buildPiCollaborationTools(piSdk, {
          sessionId,
          channelId: input.channelId!,
          modelId: model,
          workspaceId,
          permissionMode,
          agentRuntime: 'pi',
          triggeredBy,
        })
        customTools.push(...collaborationTools as typeof customTools)
      } catch (error) {
        console.error('[Pi Runtime] 注入 collaboration 工具失败:', error)
      }
    }
    // 手动压缩工具：当前 Agent 回合结束后压缩上下文并自动续跑（经权限流程）
    customTools.push({
      name: 'CompactContext',
      label: '压缩当前会话上下文',
      description: 'Compact only the current Pi Agent session after this turn finishes. Before calling, persist a durable handoff or checkpoint to the session workbench or project files as appropriate. Proma will compact the current session, then automatically continue the original task from the compacted context.',
      promptSnippet: 'CompactContext: after persisting a durable handoff/checkpoint, compact the current session context. Proma will automatically continue the original task after compaction.',
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: Array<{ type: 'text'; text: string }>; details: { toolName: string; isError: boolean } }> {
        const permission = canUseTool
          ? await canUseTool('CompactContext', {}, signal ?? new AbortController().signal)
          : { allowed: false, message: '未配置权限回调' }
        if (!permission.allowed) {
          return {
            content: [{ type: 'text', text: permission.message ?? '权限被拒绝' }],
            details: { toolName: 'CompactContext', isError: true },
          }
        }
        compactContextRequested = true
        return {
          content: [{ type: 'text', text: '将在当前 Agent 回合结束后压缩当前会话上下文，并自动从已持久化的交接状态继续原始任务。' }],
          details: { toolName: 'CompactContext', isError: false },
        }
      },
    } as unknown as ToolDefinition)
    const settingsManager = SettingsManager.inMemory({
      // 借鉴上游 Proma：上下文达到模型窗口约 80% 时由 Pi 原生自动压缩。
      compaction: { enabled: true, reserveTokens: calculatePiAutoCompactionReserveTokens(registration.model.contextWindow ?? PI_DEFAULT_CONTEXT_WINDOW) },
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
      // 只加载 Proma 工作区 skills 目录内的 Skill；SDK 默认会扫描用户全局/项目目录，
      // 用 skillsOverride 白名单过滤，防止外部 Skill 混入。
      noSkills: true,
      additionalSkillPaths: workspaceSkillsDir ? [workspaceSkillsDir] : [],
      skillsOverride: createPromaSkillsOverride(workspaceSkillsDir ? [workspaceSkillsDir] : []),
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // 以 override 固定 Proma 的系统提示词边界，避免 Pi 资源加载过程中隐式追加或
      // 覆盖工具约束；所有模型可见工具均来自 Proma Bridge。
      systemPromptOverride: () => `${systemPrompt ?? ''}\n\n<pi_proma_tools>\n只能使用以下完全一致的工具名称；不得声称工具缺失，也不得调用小写 Pi 内置工具。\n\n绝大多数网页信息需求（天气、新闻、资料、价格等）使用 WebSearch 或 WebFetch，不要为此开启 Web Bridge。只有当用户明确需要爬取特定网站、或代为操作浏览器（点击、填表、下单、登录等有状态操作）时，才使用 Web Bridge；识别到这类意图后，先向用户说明将开启受管浏览器代为操作并征求同意，再调用 WebBridgeNavigate，导航、点击、输入会触发权限确认，等待用户批准后再继续。\n\n若已使用 Web Bridge，请遵守强制顺序：WebBridgeNavigate({ url }) 成功后，才能调用 WebBridgeSnapshot、WebBridgeScreenshot、WebBridgeClick、WebBridgeType 或 WebBridgeScroll。尤其是“打开网页并截图/理解内容”任务，绝不能先调用 WebBridgeScreenshot；若尚未导航，立即调用 WebBridgeNavigate，而不是结束回答。快照返回后，点击或输入必须使用其中的 element_id。除非实际工具结果报错，否则不得声称工具缺失。\n\n记忆能力：你拥有跨会话记忆，用 RecallMemory 回忆（用户提到“之前”“上次”等回溯表述或任务可能与过去相关时），用 AddMemory 记住（出现值得记住的工作方式、偏好、重要决定时）。自然运用，不提及“记忆系统”内部概念。${goalGuidance}\n${toolPrompt}\n</pi_proma_tools>`,
    })
    await resourceLoader.reload()

    const { session } = await createAgentSession({
      cwd,
      agentDir: registration.agentDir,
      modelRuntime: registration.modelRuntime,
      model: registration.model,
      thinkingLevel: thinkingLevel ?? 'off',
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
        return
      }
      if (event.type === 'compaction_start') {
        queue.push({ type: 'system', subtype: 'compacting', session_id: sessionId } as unknown as SDKMessage)
        return
      }
      if (event.type === 'compaction_end') {
        queue.push({
          type: 'system',
          subtype: 'compact_boundary',
          session_id: sessionId,
          compactionEstimatedTokensAfter: (event as { result?: { estimatedTokensAfter?: number } }).result?.estimatedTokensAfter,
        } as unknown as SDKMessage)
        return
      }
    })
    this.activeSessions.set(sessionId, { session, unsubscribe })

    try {
      const enrichedPrompt = await enrichMessageWithDocuments(prompt, attachments)
      // 按需展开用户请求的 Skill 全文（/skill:xxx 或 skillMentions），注入 prompt 头部。
      const promptWithSkills = await preparePromptWithPromaSkills(resourceLoader, enrichedPrompt, input.skillMentions)
      // 支持 CompactContext 压缩后自动续跑：每个 prompt 完成后检查是否有压缩请求，
      // 有则执行 session.compact() 并用续跑提示词继续原任务（上限 MAX_AUTOMATIC_COMPACTION_CONTINUATIONS）。
      const runPromptLoop = async (promptText: string): Promise<void> => {
        await session.prompt(promptText, { expandPromptTemplates: false })
        if (compactContextRequested && automaticCompactionContinuations < MAX_AUTOMATIC_COMPACTION_CONTINUATIONS) {
          compactContextRequested = false
          const result = await compactCurrentSessionAfterTurn(session, sessionId, (message) => queue.push(message))
          if (result === 'compacted') {
            automaticCompactionContinuations += 1
            await runPromptLoop(PI_COMPACTION_CONTINUATION_PROMPT)
          }
        }
      }
      void runPromptLoop(promptWithSkills)
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
