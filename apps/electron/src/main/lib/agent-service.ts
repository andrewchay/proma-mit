/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { dirname } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE, normalizeAgentRuntime } from '@gravitas/shared'
import type {
  AgentSendInput,
  AgentMessage,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  PromaPermissionMode,
  ForkSessionInput,
  AgentSessionMeta,
  AgentGoal,
  UpdateAgentGoalStatusInput,
  CreateProactiveScheduleInput,
  ProactiveSchedule,
  ProactiveTaskRun,
} from '@gravitas/shared'
import { ClaudeAgentAdapter, scanAndKillOrphanedClaudeSubprocesses } from './adapters/claude-agent-adapter'
import { AISDKAgentAdapter } from './adapters/ai-sdk-agent-adapter'
import { ProviderAgnosticAgentAdapter } from './adapters/provider-agnostic-agent-adapter'
import { PiAgentAdapter } from './adapters/pi-agent-adapter'
import { RuntimeRoutingAgentAdapter } from './adapters/runtime-routing-agent-adapter'
import { AgentEventBus } from './agent-event-bus'
import { AgentOrchestrator } from './agent-orchestrator'
import { getAgentSessionWorkspacePath, getWorkspaceFilesDir, resolvePathWithinDirectory } from './config-paths'
import { createElectronRuntimeServices } from './agent-runtime/runtime-services'
import { GoalCoordinator } from './goal-runtime/goal-coordinator'
import { ProactiveScheduler } from './proactive-scheduler'
import { createAgentSession, getAgentSessionMeta } from './agent-session-manager'
import { createCollaborationDelegations, resolveCollaborationWorkspaceId } from './agent-collaboration-tools'
import { getAdapter, streamSSE } from '@gravitas/core'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import type { ProviderType } from '@gravitas/shared'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()
const runtimeServices = createElectronRuntimeServices(eventBus)
const adapter = new RuntimeRoutingAgentAdapter({
  claude: new ClaudeAgentAdapter(),
  proma: new ProviderAgnosticAgentAdapter(runtimeServices.mcp),
  pi: new PiAgentAdapter(),
  'ai-sdk': new AISDKAgentAdapter(runtimeServices.mcp),
})
const goalCoordinator = new GoalCoordinator()
const proactiveScheduler = new ProactiveScheduler()
const orchestrator = new AgentOrchestrator(
  adapter,
  eventBus,
  runtimeServices,
  (sessionId, checkpoint) => goalCoordinator.submitCheckpoint(sessionId, checkpoint).then(() => undefined),
  (sessionId) => Boolean(goalCoordinator.getActiveBySession(sessionId)),
)

goalCoordinator.setContinuationRunner(async ({ goal, prompt }) => {
  if (!goal.channelId) throw new Error('Goal 缺少渠道信息，无法自动续跑')
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return false
  await runAgent({
    sessionId: goal.sessionId,
    // 自动续跑不是用户新发的一条消息；将调度提示作为内部运行时上下文，避免展示在对话中。
    userMessage: '',
    runtimeInstruction: prompt,
    channelId: goal.channelId,
    modelId: goal.modelId,
    workspaceId: goal.workspaceId,
    agentRuntime: goal.runtime,
  }, win.webContents, true)
  return true
})
void goalCoordinator.recoverDueGoals().catch((error) => {
  console.error('[Goal] 恢复到期 Goal 失败:', error)
})

proactiveScheduler.setRunner(async (schedule) => {
  let runError: string | undefined
  // 新会话模式：每次运行时创建新 Agent 会话，独立承载本次任务
  let targetSessionId = schedule.sessionId
  if (schedule.newSession) {
    const freshMeta = createAgentSession(
      `定时任务：${schedule.title.slice(0, 30)}`,
      schedule.channelId,
      schedule.workspaceId,
      schedule.modelId,
      schedule.runtime,
    )
    targetSessionId = freshMeta.id
  }
  if (!targetSessionId) {
    throw new Error('定时任务缺少目标会话（非新建会话模式且未回填 sessionId）')
  }
  // modelId 为空时兜底：从 channel 解析默认模型，避免旧数据/直接 IPC 创建的任务因 model 缺失而 400。
  let effectiveModelId = schedule.modelId
  if (!effectiveModelId && schedule.channelId) {
    const channel = await runtimeServices.credentials.resolveChannel(schedule.channelId)
    if (channel?.defaultModel) effectiveModelId = channel.defaultModel
  }
  await runAgentHeadless({
    sessionId: targetSessionId,
    userMessage: schedule.prompt,
    channelId: schedule.channelId,
    modelId: effectiveModelId,
    workspaceId: schedule.workspaceId,
    agentRuntime: schedule.runtime,
    permissionModeOverride: schedule.permissionMode,
  }, {
    onError: (error) => { runError = error },
    onComplete: () => {},
    onTitleUpdated: () => {},
  })
  if (runError) throw new Error(runError)
  return { sessionId: targetSessionId }
})
void proactiveScheduler.recover().catch((error) => {
  console.error('[Proactive Scheduler] 恢复到期任务失败:', error)
})

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }
export { goalCoordinator }

export function createProactiveSchedule(input: CreateProactiveScheduleInput): ProactiveSchedule {
  return proactiveScheduler.create(input)
}

export function listProactiveSchedules(): ProactiveSchedule[] {
  return proactiveScheduler.listSchedules()
}

export function listProactiveTaskRuns(): ProactiveTaskRun[] {
  return proactiveScheduler.listRuns()
}

export function pauseProactiveSchedule(scheduleId: string): ProactiveSchedule {
  return proactiveScheduler.pause(scheduleId)
}

export function resumeProactiveSchedule(scheduleId: string): ProactiveSchedule {
  return proactiveScheduler.resume(scheduleId)
}

export function deleteProactiveSchedule(scheduleId: string): void {
  proactiveScheduler.delete(scheduleId)
}

export async function runProactiveScheduleNow(scheduleId: string): Promise<ProactiveTaskRun> {
  return proactiveScheduler.runNow(scheduleId)
}

export function listAgentGoals(sessionId: string): AgentGoal[] {
  return goalCoordinator.listBySession(sessionId)
}

export function updateAgentGoalStatus(input: UpdateAgentGoalStatusInput): AgentGoal {
  const goal = goalCoordinator.setStatus(input.goalId, input.status)
  // Goal 的暂停或取消必须在主进程原子地同时撤销正在执行或已排队的续跑。
  // 不能依赖渲染层的 streaming 状态：续跑可能已经从 UI 的状态机退出，
  // 但仍占用编排器并会在当前 turn 结束后再次调度。
  if (input.status === 'waiting' || input.status === 'cancelled') stopAgent(goal.sessionId)
  return goal
}

/**
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new Map<string, WebContents>()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
function registerWebContents(sessionId: string, wc: WebContents): void {
  // 同一 sessionId 切换 webContents 时直接覆盖；旧 wc 的 destroyed 钩子仍由 WeakSet 持有，
  // 触发时会扫描 sessionWebContents 清理所有指向旧 wc 的条目（见下方实现）。
  sessionWebContents.set(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理所有指向它的条目
    for (const [sid, mappedWc] of sessionWebContents) {
      if (mappedWc === wc) sessionWebContents.delete(sid)
    }
  })
}

// ===== EventBus IPC 转发中间件 =====

eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
  if (wc && !wc.isDestroyed()) {
    try {
      if (payload.kind === 'queue_state') {
        // 发送队列状态走独立通道，供 UI 展示排队贴片（编号/内容/立即执行/撤回）
        wc.send(AGENT_IPC_CHANNELS.QUEUED_MESSAGE_STATUS, payload.event)
      } else {
        wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
      }
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  next()
})

// ===== IPC 薄包装函数 =====

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
  isGoalContinuation = false,
): Promise<void> {
  const effectiveInput = prepareGoalInput(input, isGoalContinuation)
  // 更新 webContents 映射（允许覆盖 — 由 orchestrator.activeSessions 处理真正的并发保护）
  registerWebContents(effectiveInput.sessionId, webContents)
  try {
    await orchestrator.sendMessage(effectiveInput, {
      onError: (error) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: effectiveInput.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, opts) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
            sessionId: effectiveInput.sessionId,
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            resultSubtype: opts?.resultSubtype,
          })
        }
      },
      onTitleUpdated: (title) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: effectiveInput.sessionId,
            title,
          })
        }
      },
    })
    await goalCoordinator.onTurnFinished(effectiveInput.sessionId)
  } catch (err) {
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    if (!webContents.isDestroyed()) {
      webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
          sessionId: effectiveInput.sessionId,
        error: errorMessage,
      })
      webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
          sessionId: effectiveInput.sessionId,
        messages: [],
        stoppedByUser: false,
      })
    }
  } finally {
    // 仅在 orchestrator 已完成此会话时清理映射
    // 避免被拒绝的请求误删仍在运行的会话映射
    if (!orchestrator.isActive(effectiveInput.sessionId)) {
      sessionWebContents.delete(effectiveInput.sessionId)
    }
  }
}

function prepareGoalInput(input: AgentSendInput, isGoalContinuation: boolean): AgentSendInput {
  if (isGoalContinuation) return input
  const match = input.userMessage.match(/^\s*@goal\b([\s\S]*)$/i)
  if (!match) {
    goalCoordinator.pauseForUserInput(input.sessionId)
    return input
  }
  const runtime = normalizeAgentRuntime(input.agentRuntime)
  if (runtime !== 'proma' && runtime !== 'pi' && runtime !== 'ai-sdk') {
    throw new Error('@goal 当前仅支持 Proma、Pi 或 AI SDK Runtime')
  }
  const objective = (match[1] ?? '').trim()
  if (!objective) throw new Error('@goal 后需要填写要持续推进的目标')
  const goal = goalCoordinator.create({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    modelId: input.modelId,
    runtime,
    objective,
  })
  return {
    ...input,
    agentRuntime: runtime,
    runtimeInstruction: [
      `[Goal Runtime 已激活，Goal ID: ${goal.id}]`,
      `Goal 目标：${objective}`,
      '这是一个需要持续跟进的目标。基于实际工具结果推进；在每轮结束前必须调用 GoalCheckpoint。只有有验收证据时才能提交 complete。',
    ].join('\n'),
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: {
    onError: (error: string) => void
    onComplete: (messages?: AgentMessage[]) => void
    onTitleUpdated: (title: string) => void
    source?: import('@gravitas/shared').AgentExternalRunSource
    /** 发起此次 headless 运行的可见会话，用于将事件路由回其 renderer。 */
    originSessionId?: string
  },
): Promise<void> {
  // 尝试注册目标窗口 webContents，让流式事件同步推送到桌面端。
  // 委派子会话优先复用父会话所在窗口；没有可用父窗口时才回退通用主窗口。
  const fallbackWin = BrowserWindow.getAllWindows()[0] ?? null
  const wc = callbacks.originSessionId
    ? (sessionWebContents.get(callbacks.originSessionId) ?? fallbackWin?.webContents ?? null)
    : (fallbackWin?.webContents ?? null)
  if (wc && !wc.isDestroyed()) {
    registerWebContents(input.sessionId, wc)
  }

  try {
    await orchestrator.sendMessage(input, {
      onError: (error) => {
        callbacks.onError(error)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, opts) => {
        callbacks.onComplete(messages)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
            sessionId: input.sessionId,
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            resultSubtype: opts?.resultSubtype,
          })
        }
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    callbacks.onError(errorMessage)
    callbacks.onComplete()
    if (wc && !wc.isDestroyed()) {
      wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: input.sessionId, error: errorMessage })
      wc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, { sessionId: input.sessionId, messages: [], stoppedByUser: false })
    }
  } finally {
    if (!orchestrator.isActive(input.sessionId)) {
      sessionWebContents.delete(input.sessionId)
    }
  }
}

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 中止指定会话的 Agent 执行
 */
export function stopAgent(sessionId: string): void {
  orchestrator.stop(sessionId)
}

// 注册 headless runner 与 stopper，供 collaboration 等内置工具启动/停止真实 Agent 会话
import { setAgentStopper, setHeadlessAgentRunner } from './agent-headless-runner-registry'
setHeadlessAgentRunner(runAgentHeadless)
setAgentStopper(stopAgent)

// 注册协作子会话阻塞事件监听（AskUser / Permission 冒泡到父会话）
import('./agent-collaboration-tools').then(({ registerCollaborationEventBus }) => {
  registerCollaborationEventBus(eventBus)
}).catch((error) => {
  console.error('[Agent 服务] 注册 collaboration EventBus 失败:', error)
})

/**
 * 分叉 Agent 会话
 *
 * 委托给 Orchestrator，由其根据是否存在 sdkSessionId 选择 Provider-Agnostic 或 Claude SDK 路径。
 */
export async function forkAgentSession(input: ForkSessionInput): Promise<AgentSessionMeta> {
  return orchestrator.forkAgentSession(input)
}

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<import('@gravitas/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return orchestrator.isActive(sessionId)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  orchestrator.stopAll()
}

/**
 * 退出前最后兜底：扫描并强杀所有孤儿 claude-agent-sdk 子进程
 *
 * 必须在 stopAllAgents() 之后调用。针对 pidMap 未覆盖、dispose 漏杀等极端场景。
 * 同步执行，不 await，确保 before-quit 能在 Electron 超时前完成。
 */
export function killOrphanedClaudeSubprocesses(): void {
  scanAndKillOrphanedClaudeSubprocesses()
}

/**
 * 运行中动态切换会话的权限模式
 *
 * 同时更新 Proma 侧（canUseTool 动态读取）和 SDK 侧（query.setPermissionMode）。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: PromaPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt },
  )
}

/**
 * 立即执行排队的某条消息：把目标提到队首并打断当前生成。
 * @returns true 表示已找到并处理；false 表示该 queueId 不在队列
 */
export function promoteQueuedAgentMessage(sessionId: string, queueId: string): boolean {
  return orchestrator.promoteQueuedMessage(sessionId, queueId)
}

/**
 * 撤回排队中的某条消息（未开始执行前移除）。
 * @returns true 表示已移除；false 表示不在队列
 */
export function cancelQueuedAgentMessage(sessionId: string, queueId: string): boolean {
  return orchestrator.cancelQueuedMessage(sessionId, queueId)
}

/** 获取会话当前排队消息数（不含正在执行中的那一条） */
export function getQueuedAgentMessageCount(sessionId: string): number {
  return orchestrator.getQueuedMessageCount(sessionId)
}

// ===== 协作子会话（手动并发创建入口） =====

/**
 * 从前端「发起协作子任务」入口手动创建多个并行协作子会话。
 *
 * 从父会话元数据推导 CollaborationToolContext（channelId / workspaceId /
 * agentRuntime / modelId / permissionMode），复用 collaboration 底层创建真实
 * 子会话（parentSessionId / delegationStatus=running），从而在侧栏父子树面板显示。
 * 不依赖父 Agent 自发调用 delegate_agents。
 */
export function createAgentCollabDelegations(
  parentSessionId: string,
  tasks: Array<{ title?: string; task: string; role?: string; expectedOutput?: string }>,
): { delegations: Array<{ delegationId: string; childSessionId: string; title: string; status: string }>; failures: Array<{ index: number; title?: string; error: string }> } {
  const parent = getAgentSessionMeta(parentSessionId)
  if (!parent) return { delegations: [], failures: [{ index: 0, error: '父会话不存在' }] }

  const workspaceId = resolveCollaborationWorkspaceId(parent.workspaceId)
  const ctx = {
    sessionId: parentSessionId,
    channelId: parent.channelId!,
    workspaceId,
    modelId: parent.modelId || undefined,
    agentRuntime: (parent.agentRuntime as 'proma' | 'pi' | 'ai-sdk' | 'claude' | undefined) ?? 'pi',
    permissionMode: (parent.permissionMode as PromaPermissionMode | undefined) ?? 'bypassPermissions',
    triggeredBy: 'user' as const,
  }

  return createCollaborationDelegations(ctx, tasks as Array<{ title?: string; task: string; role?: 'explore' | 'research' | 'implement' | 'review' | 'custom'; expectedOutput?: string }>)
}

// ===== 自动拆分子任务（用模型把主任务拆成多个并行协作子任务） =====

/** 从 LLM 输出中尽力解析 JSON 任务数组；解析失败返回 [] */
function parseSplitTasksOutput(raw: string): Array<{ task: string }> {
  let text = raw.trim()
  // 1. 剥离 markdown 代码块围栏
  text = text.replace(/```(?:json)?/gi, '')
  // 2. 提取第一个 [ ... ] 数组
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1)
  }
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === 'string') return { task: item.trim() }
          if (item && typeof item === 'object') {
            const t = (item as { task?: unknown; task_desc?: unknown; title?: unknown }).task
              ?? (item as { task?: unknown; task_desc?: unknown }).task_desc
              ?? (item as { title?: unknown }).title
            if (typeof t === 'string' && t.trim()) return { task: t.trim() }
          }
          return null
        })
        .filter((t): t is { task: string } => t !== null)
    }
  } catch {
    // 继续尝试按行切分
  }
  // 3. 兜底：按换行/分号切分为若干任务行
  const lines = text.split(/\n|；|;/).map((l) => l.trim()).filter((l) => l.length > 0)
  return lines.map((l) => ({ task: l }))
}

/**
 * 用模型把主任务自动拆分为多个自包含协作子任务（供「并行协作子任务」按钮使用）。
 *
 * 使用父会话的渠道/模型发起一次流式请求，prompt 要求输出 JSON 数组；对模型输出做
 * 多层容错解析，解析失败则兜底为「单任务 = 原主任务」，保证不报错、不跑偏。
 */
export async function splitCollabMainTask(
  parentSessionId: string,
  mainTask: string,
): Promise<Array<{ task: string }>> {
  const parent = getAgentSessionMeta(parentSessionId)
  if (!parent || !parent.channelId) return [{ task: mainTask }]
  if (!mainTask.trim()) return [{ task: mainTask }]

  const channel = await runtimeServices.credentials.resolveChannel(parent.channelId)
  if (!channel) return [{ task: mainTask }]

  const modelId = parent.modelId || (channel as { defaultModel?: string }).defaultModel || undefined
  const providerAdapter = getAdapter(channel.provider as ProviderType)
  const request = providerAdapter.buildStreamRequest({
    baseUrl: channel.baseUrl,
    apiKey: channel.apiKey,
    modelId: modelId as string,
    history: [],
    readImageAttachments: () => [],
    // 系统提示：拆分子任务，只输出 JSON
    systemMessage:
      '你是任务分解助手。把用户的主任务拆分成若干自包含、可并行执行的子任务。' +
      '每个子任务要独立完整、不依赖其他子任务即可执行。只输出 JSON 数组，' +
      '格式为 [{"task": "子任务描述"}]。不要输出任何其他文字、不要加解释、不要加markdown围栏。' +
      '根据主任务复杂度决定拆成几个子任务（一般 2~6 个）。',
    userMessage: `主任务：${mainTask}`,
  })

  const proxyUrl = await getEffectiveProxyUrl()
  const fetchFn = getFetchFn(proxyUrl)
  try {
    const result = await streamSSE({
      request,
      adapter: providerAdapter,
      signal: undefined,
      fetchFn,
      onEvent: () => {},
    })
    const tasks = parseSplitTasksOutput(result.content)
    const valid = tasks.map((t) => t.task.trim()).filter(Boolean).slice(0, 12)
    return valid.length > 0 ? valid.map((task) => ({ task })) : [{ task: mainTask }]
  } catch (error) {
    console.warn('[Agent 服务] 自动拆分子任务失败，回退为主任务:', error)
    return [{ task: mainTask }]
  }
}

/**
 * 「自动拆分子任务并并行创建协作子会话」组合入口：
 * 模型先拆主任务 → 并行创建协作子会话 → 返回创建结果。
 */
export async function splitAndCreateCollabDelegations(
  parentSessionId: string,
  mainTask: string,
): Promise<import('@gravitas/shared').CreateCollabDelegationsResult> {
  const tasks = await splitCollabMainTask(parentSessionId, mainTask)
  return createAgentCollabDelegations(parentSessionId, tasks)
}

// ===== 文件操作 =====

/**
 * 在安全根目录内解析文件路径，并自动处理同名文件重命名。
 *
 * @returns 解析后的绝对路径；若文件名非法（如包含 .. 或绝对路径）返回 null
 */
function resolveAgentSavePath(rootDir: string, filename: string, usedPaths: Set<string>): string | null {
  let targetPath: string
  try {
    targetPath = resolvePathWithinDirectory(rootDir, filename, 'Agent 文件')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[Agent 服务] 拒绝非法文件名: ${filename} (${message})`)
    return null
  }

  if (usedPaths.has(targetPath) || existsSync(targetPath)) {
    const dotIdx = filename.lastIndexOf('.')
    const baseName = dotIdx > 0 ? filename.slice(0, dotIdx) : filename
    const ext = dotIdx > 0 ? filename.slice(dotIdx) : ''
    let counter = 1
    while (true) {
      const candidate = `${baseName}-${counter}${ext}`
      try {
        targetPath = resolvePathWithinDirectory(rootDir, candidate, 'Agent 文件')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[Agent 服务] 拒绝非法文件名: ${candidate} (${message})`)
        return null
      }
      if (!usedPaths.has(targetPath) && !existsSync(targetPath)) break
      counter++
    }
  }

  return targetPath
}

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入 session 的 cwd，供 Agent 通过 Read 工具读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    const targetPath = resolveAgentSavePath(sessionDir, file.filename, usedPaths)
    if (!targetPath) continue
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    // 防御性检查：base64 字符串长度估算是否超 100MB 限制
    // base64 编码膨胀率约 4/3，data.length * 0.75 ≈ 原始字节数
    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath, size: buffer.length })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * 保存文件到工作区文件目录
 *
 * 将 base64 编码的文件写入工作区 workspace-files/ 目录，所有会话均可访问。
 */
export function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): AgentSavedFile[] {
  const wsFilesDir = getWorkspaceFilesDir(input.workspaceSlug)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    const targetPath = resolveAgentSavePath(wsFilesDir, file.filename, usedPaths)
    if (!targetPath) continue
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 工作区文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(wsFilesDir.length + 1)
    results.push({ filename: actualFilename, targetPath, size: buffer.length })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
