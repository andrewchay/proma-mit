/**
 * macOS 灵动岛通知（Dynamic Island）类型定义。
 *
 * 设计遵循官方 Proma Agent Island 的成熟架构：
 * - 主进程状态机拥有全部产品状态，原生渲染层只负责画；
 * - 会话 phase 语义：running 是执行脉冲，needs-interaction 需用户处理，
 *   completed/error 保留未读窗口后消失；
 * - 同一时刻只显示 attention 最高的会话，点击 dismiss 后切换到下一个或隐藏；
 * - 三源归一：AI 主动调用、Agent 事件自动通知、手动测试共用 NotifyRequest。
 */

/** 通知等级 → 决定 SF Symbol 与颜色（原生侧映射） */
export type DynamicIslandLevel = 'info' | 'success' | 'warning' | 'error' | 'progress'

/** 通知来源（用于状态面板展示与审计） */
export type DynamicIslandSource = 'ai' | 'agent_event' | 'manual'

/** 会话阶段（驱动灵动岛状态色与 attention） */
export type DynamicIslandSessionPhase = 'idle' | 'running' | 'needs-interaction' | 'completed' | 'error'

/** 需要用户交互的类型 */
export type DynamicIslandInteractionKind = 'permission' | 'ask_user_question' | 'plan_review'

/** 单个 Agent 会话的灵动岛快照 */
export interface DynamicIslandSessionSnapshot {
  sessionId: string
  title: string
  phase: DynamicIslandSessionPhase
  interactionKind?: DynamicIslandInteractionKind
  /** 当前动作摘要（工具名 / 等待内容 / 错误摘要等） */
  detail: string
  /** 是否需要用户注意（权限/提问/完成未读） */
  attention: boolean
  startedAt: number
  lastActivityAt: number
}

/** 收起态 pill 的聚合摘要 */
export interface DynamicIslandPillSnapshot {
  /** 优先会话的 phase（没有会话时为 idle） */
  priorityStatus: DynamicIslandSessionPhase
  /** 全部会话数 */
  sessionCount: number
  /** 活跃（running / needs-interaction）会话数 */
  activeSessionCount: number
  /** 等待用户交互的会话数 */
  pendingInteractionCount: number
  /** 未读完成 / 错误会话数 */
  unreadCompletedCount: number
}

/** 单条通知请求（三源归一后的统一形状） */
export interface DynamicIslandNotifyInput {
  /** 业务侧幂等 id；不传时由服务端生成 */
  id?: string
  title: string
  /** 副标题/正文，可省略 */
  body?: string
  level?: DynamicIslandLevel
  /** 常驻（progress=0）；其余默认 4500ms */
  timeoutMs?: number
  /** 点击是否激活并导航（默认 false） */
  activateOnClick?: boolean
  /** 点击后导航到指定会话（activateOnClick 为 true 时有效） */
  sessionId?: string
}

/** 归一化后的内部请求（含服务端补全字段） */
export interface DynamicIslandRequest extends DynamicIslandNotifyInput {
  id: string
  level: DynamicIslandLevel
  timeoutMs: number
  createdAt: number
  source: DynamicIslandSource
}

/** 设置面板状态 */
export interface DynamicIslandState {
  /** 当前平台是否支持（macOS 才为 true） */
  supported: boolean
  /** 渲染进程是否在跑 */
  running: boolean
  /** 总开关 */
  enabled: boolean
  /** 会话状态摘要（用于设置面板展示当前活动） */
  pill: DynamicIslandPillSnapshot
  /** 最近会话快照（不持久化，最多 5 条） */
  recent: DynamicIslandSessionSnapshot[]
}

/** 项目静音查询/设置结果 */
export interface DynamicIslandProjectMutedResult {
  muted: boolean
}

/** 通知操作结果 */
export interface DynamicIslandActionResult {
  ok: boolean
  reason?: string
}

/** IPC 通道 */
export const DYNAMIC_ISLAND_IPC_CHANNELS = {
  GET_STATE: 'dynamic-island:get-state',
  SET_ENABLED: 'dynamic-island:set-enabled',
  DISMISS: 'dynamic-island:dismiss',
  TEST: 'dynamic-island:test',
  NOTIFY: 'dynamic-island:notify',
  GET_PROJECT_MUTED: 'dynamic-island:get-project-muted',
  SET_PROJECT_MUTED: 'dynamic-island:set-project-muted',
} as const
