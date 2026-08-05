/**
 * AppEventBus — 统一任务事件总线（P0-2）。
 *
 * 订阅 Agent 底层事件（AgentStreamPayload），归一化为面向消费者的
 * AppEventEnvelope（started / progress / waiting_action / completed / failed），
 * 供灵动岛、飞书/钉钉 Bridge、托盘、Run Center 等消费端统一消费。
 *
 * 消费端不应直接解析 sdk_message/agent_event/proma_event；
 * 统一从这里订阅高层任务事件。
 */

import type { AppEventEnvelope, AgentStreamPayload } from '@gravitas/shared'

type AppEventHandler = (event: AppEventEnvelope) => void

/** 从 sessionId + AgentStreamPayload 归一化为 AppEventEnvelope；无法归一化返回 null */
export function toAppEvent(sessionId: string, payload: AgentStreamPayload): AppEventEnvelope | null {
  const base = {
    source: 'agent' as const,
    taskId: sessionId,
    title: sessionId.slice(0, 8),
    sessionId,
    timestamp: Date.now(),
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }

  if (payload.kind === 'proma_event') {
    const event = payload.event
    switch (event.type) {
      case 'permission_request':
        return {
          ...base,
          type: 'waiting_action',
          actionKind: 'permission',
          detail: event.request.description ?? '等待权限确认',
        }
      case 'ask_user_request':
        return {
          ...base,
          type: 'waiting_action',
          actionKind: 'ask_user_question',
          detail: event.request.questions?.[0]?.question ?? event.request.questions?.[0]?.header ?? '等待回答',
        }
      case 'exit_plan_mode_request':
        return {
          ...base,
          type: 'waiting_action',
          actionKind: 'plan_review',
          detail: '等待计划审批',
        }
      case 'external_run_started':
        return {
          ...base,
          type: 'started',
          ...(event.title ? { title: event.title } : {}),
        }
      default:
        return null
    }
  }

  if (payload.kind === 'agent_event') {
    const event = payload.event
    if (event.type === 'complete') {
      return { ...base, type: 'completed', detail: '任务已完成' }
    }
    if (event.type === 'error') {
      return { ...base, type: 'failed', detail: event.message }
    }
    if (event.type === 'typed_error') {
      return { ...base, type: 'failed', detail: event.error.message ?? '任务失败' }
    }
    return null
  }

  if (payload.kind === 'sdk_message') {
    const message = payload.message
    if (message.type === 'assistant') {
      const aMsg = message as import('@gravitas/shared').SDKAssistantMessage
      if (aMsg.isReplay) return null
      if (aMsg.error) {
        return { ...base, type: 'failed', detail: aMsg.error.message ?? '发生错误' }
      }
      // 提取最近一次工具名作为 progress detail
      let detail = ''
      for (const block of aMsg.message.content ?? []) {
        if (block.type === 'tool_use') {
          const toolBlock = block as { name?: string; input?: Record<string, unknown> }
          detail = `正在使用 ${toolBlock.input?.['_displayName'] ?? toolBlock.name ?? '工具'}`
        } else if (block.type === 'text') {
          const textBlock = block as { text?: unknown }
          if (typeof textBlock.text === 'string' && textBlock.text) detail = textBlock.text
        }
      }
      return { ...base, type: 'progress', detail: detail || '正在执行' }
    }
    if (message.type === 'result') {
      const rMsg = message as import('@gravitas/shared').SDKResultMessage
      if (rMsg.subtype === 'success') {
        return { ...base, type: 'completed', detail: '已完成' }
      }
      return { ...base, type: 'failed', detail: rMsg.errors?.[0] ?? '执行出错' }
    }
    if (message.type === 'system') {
      const sMsg = message as import('@gravitas/shared').SDKSystemMessage
      if (sMsg.subtype === 'task_started') {
        return { ...base, type: 'progress', detail: `子任务：${sMsg.description ?? ''}` }
      }
      if (sMsg.subtype === 'permission_denied') {
        return { ...base, type: 'waiting_action', actionKind: 'permission', detail: '权限被拒绝' }
      }
    }
    return null
  }

  return null
}

class AppEventBus {
  private handlers: Set<AppEventHandler> = new Set()
  private unsubscribeSource: (() => void) | null = null
  /** 最近事件环形缓冲（消费端启动时可读取最近状态） */
  private recent: AppEventEnvelope[] = []
  private readonly maxRecent = 50
  private started = false

  on(handler: AppEventHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** 读取最近事件（按时间倒序） */
  getRecent(limit = 20): AppEventEnvelope[] {
    return this.recent.slice(0, limit)
  }

  /** 测试/内部：手动派发一条底层事件 */
  dispatch(sessionId: string, payload: AgentStreamPayload): void {
    const event = toAppEvent(sessionId, payload)
    if (!event) return
    // P1-3: Goal 证据自动沉淀（completed/failed 且会话绑定 Goal 时）
    this.sinkGoalEvidence(event)
    this.recent.unshift(event)
    if (this.recent.length > this.maxRecent) this.recent.length = this.maxRecent
    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('[AppEventBus] 事件处理器错误:', error)
      }
    }
  }

  /** 把运行证据沉淀到关联 Goal（P1-3） */
  private sinkGoalEvidence(event: AppEventEnvelope): void {
    if (event.type !== 'completed' && event.type !== 'failed') return
    if (!event.sessionId) return
    try {
      // 延迟 require，避免模块加载期循环依赖
      const { getAgentSessionMeta } = require('./agent-session-manager') as { getAgentSessionMeta: (id: string) => { goalId?: string } | undefined }
      const goalId = getAgentSessionMeta(event.sessionId)?.goalId
      if (!goalId) return
      const { buildSessionEvidence, formatEvidenceSummary } = require('./evidence-service') as {
        buildSessionEvidence: (sid: string, state: 'completed' | 'failed') => import('@gravitas/shared').RunEvidence
        formatEvidenceSummary: (e: import('@gravitas/shared').RunEvidence) => string
      }
      const { appendGoalEvidence } = require('./goal-service') as { appendGoalEvidence: (goalId: string, e: string) => unknown }
      const evidence = buildSessionEvidence(event.sessionId, event.type === 'completed' ? 'completed' : 'failed')
      const summary = formatEvidenceSummary(evidence)
      appendGoalEvidence(goalId, summary)
    } catch (error) {
      console.error('[AppEventBus] Goal 证据沉淀失败:', error)
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    // 延迟 require 避免模块加载期循环依赖（agent-service 依赖本模块？否，仅消费端）
    const { agentEventBus } = require('./agent-service') as { agentEventBus: { on: (h: (sid: string, p: AgentStreamPayload) => void) => () => void } }
    this.unsubscribeSource = agentEventBus.on((sessionId, payload) => {
      this.dispatch(sessionId, payload)
    })
  }

  stop(): void {
    this.unsubscribeSource?.()
    this.unsubscribeSource = null
    this.started = false
    this.handlers.clear()
  }
}

/** 单例 */
let bus: AppEventBus | null = null

export function getAppEventBus(): AppEventBus {
  bus ??= new AppEventBus()
  return bus
}

export function startAppEventBus(): void {
  getAppEventBus().start()
}

export function stopAppEventBus(): void {
  bus?.stop()
  bus = null
}
