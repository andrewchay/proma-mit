/**
 * AppEventEnvelope — 面向消费者的统一任务事件契约（P0-2）。
 *
 * 目的：让灵动岛、飞书/钉钉 Bridge、托盘、Run Center 等消费端
 * 不再各自解析 AgentStreamPayload（sdk_message/agent_event/proma_event），
 * 而是消费统一的高层任务事件。
 *
 * 五态语义：
 * - started          任务开始（Agent 会话 / Workflow Run / Automation 触发）
 * - progress         任务进行中（附带阶段/工具/进度）
 * - waiting_action   需要用户处理（权限/提问/计划审批）
 * - completed        任务成功完成
 * - failed           任务失败
 */

/** 任务来源 */
export type AppEventSource = 'agent' | 'workflow' | 'automation' | 'bridge' | 'external'

/** 需要用户交互的类型 */
export type AppEventActionKind = 'permission' | 'ask_user_question' | 'plan_review'

/** 统一任务事件（消费端只依赖此结构） */
export type AppEventEnvelope =
  | {
      /** 事件 ID（幂等） */
      id: string
      type: 'started'
      source: AppEventSource
      /** 任务标识（Agent sessionId / Workflow runId / Automation runId） */
      taskId: string
      /** 任务标题 */
      title: string
      /** 关联会话 ID（打开/导航用） */
      sessionId?: string
      timestamp: number
    }
  | {
      id: string
      type: 'progress'
      source: AppEventSource
      taskId: string
      title: string
      sessionId?: string
      /** 当前阶段/工具/动作摘要 */
      detail: string
      /** 阶段进度 0-100（可选） */
      progress?: number
      timestamp: number
    }
  | {
      id: string
      type: 'waiting_action'
      source: AppEventSource
      taskId: string
      title: string
      sessionId?: string
      /** 需要什么交互 */
      actionKind: AppEventActionKind
      /** 交互详情（权限描述/问题/计划摘要） */
      detail: string
      timestamp: number
    }
  | {
      id: string
      type: 'completed'
      source: AppEventSource
      taskId: string
      title: string
      sessionId?: string
      /** 结果摘要 */
      detail?: string
      /** 关联 Goal id */
      goalId?: string
      /** 本次运行的结构化证据 */
      evidence?: import('./run-record').RunEvidence
      timestamp: number
    }
  | {
      id: string
      type: 'failed'
      source: AppEventSource
      taskId: string
      title: string
      sessionId?: string
      detail: string
      /** 是否可重试 */
      retryable?: boolean
      /** 关联 Goal id */
      goalId?: string
      timestamp: number
    }

/** 便捷构造：生成带 id/timestamp 的 envelope 基础字段 */
export function createAppEventBase(
  source: AppEventSource,
  taskId: string,
  title: string,
  sessionId?: string,
): Pick<AppEventEnvelope, 'id' | 'source' | 'taskId' | 'title' | 'sessionId' | 'timestamp'> {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    taskId,
    title,
    ...(sessionId ? { sessionId } : {}),
    timestamp: Date.now(),
  }
}
