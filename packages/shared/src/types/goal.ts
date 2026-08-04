/**
 * Goal（目标）类型定义
 *
 * 借鉴 LoopX 的"循环工程（Loop Engineering）"思想引入：
 * Goal 是长生命周期工作对象，跨会话/定时任务/工作流持久追踪，
 * 拥有目标、作用域、用户门控、证据、配额。
 *
 * 状态权威在本地的 ~/.proma-mit/goals/{goalId}.json，Dashboard 仅做投影。
 */

/** Goal 生命周期阶段 */
export type GoalPhase =
  | 'draft' // 草稿，尚未启动
  | 'active' // 有活跃 todo，正在推进
  | 'waiting_user' // 等待用户判断（gate）
  | 'blocked' // 被阻塞
  | 'completed' // 目标完成
  | 'archived' // 已归档

/** Goal Todo 类型 */
export type GoalTodoClass =
  | 'user_gate' // 需要用户判断
  | 'agent_work' // Agent 执行
  | 'monitor' // 监控 / 观察
  | 'checkpoint' // 中间检查点

/** Goal Todo 状态 */
export type GoalTodoStatus =
  | 'open'
  | 'claimed'
  | 'in_progress'
  | 'blocked'
  | 'done'
  | 'deferred'

/** Goal 内单个 Todo */
export interface GoalTodo {
  id: string
  text: string
  class: GoalTodoClass
  status: GoalTodoStatus
  /** 声明该 todo 的会话/Agent ID */
  claimedBy?: string
  /** 解码该 todo 需要先完成的 todo id（解锁关系） */
  unblocksTodoId?: string
  /** 关联的证据 id */
  evidenceIds?: string[]
  createdAt: number
  updatedAt: number
}

/** 用户门控（人类判断决策点） */
export interface GoalGate {
  id: string
  question: string
  status: 'open' | 'resolved'
  /** 谁提出的门控 */
  proposedBy?: string
  createdAt: number
  /** 用户解决结果的时间戳 */
  resolvedAt?: number
  /** 用户的解决结果摘要 */
  resolution?: string
}

/** Goal 配额策略 */
export interface GoalQuota {
  /** 本 Goal 可消耗的最大预算（USD）。留空表示不限制 */
  maxBudgetUsd?: number
  /** 已消耗预算（USD） */
  spentUsd?: number
}

/** Goal 持久状态 */
export interface Goal {
  id: string
  /** 简短标题 */
  title: string
  /** 完整目标描述 */
  objective: string
  /** 允许操作的作用域（路径 / 边界） */
  scope: string[]
  phase: GoalPhase
  /** 关联工作区 */
  workspaceId?: string
  createdAt: number
  updatedAt: number
  /** 当前持有的 todo id */
  ownerTodoId?: string
  todos: GoalTodo[]
  gates: GoalGate[]
  /** 证据摘要（最近 N 条） */
  evidence: string[]
  /** 权限来源（如 project agent） */
  authoritySource?: string
  quota?: GoalQuota
}

/** Goal 索引（轻量，用于列表加载） */
export interface GoalIndex {
  version: 1
  goals: Array<{
    id: string
    title: string
    phase: GoalPhase
    workspaceId?: string
    updatedAt: number
    openTodos: number
    openGates: number
  }>
  lastUpdatedAt: number
}

/** Goal 查询输入 */
export interface GoalQuery {
  phase?: GoalPhase
  workspaceId?: string
}

/** Goal 创建输入 */
export interface GoalCreateInput {
  title: string
  objective: string
  scope?: string[]
  workspaceId?: string
  authoritySource?: string
}

/** Goal 更新输入 */
export interface GoalUpdateInput {
  title?: string
  objective?: string
  scope?: string[]
  phase?: GoalPhase
  quota?: GoalQuota
}

/** Upsert Todo 输入 */
export interface UpsertTodoInput {
  id?: string
  text: string
  class?: GoalTodo['class']
  claimedBy?: string
  unblocksTodoId?: string
}

/** IPC 通道 */
export const GOAL_IPC_CHANNELS = {
  /** 创建 Goal */
  CREATE: 'goal:create',
  /** 读取单个 Goal */
  GET: 'goal:get',
  /** 列表查询 */
  LIST: 'goal:list',
  /** 更新 Goal 字段 */
  UPDATE: 'goal:update',
  /** 删除 Goal */
  DELETE: 'goal:delete',
  /** 新增/更新 todo */
  UPSERT_TODO: 'goal:upsert-todo',
  /** 更新 todo 状态 */
  UPDATE_TODO_STATUS: 'goal:update-todo-status',
  /** 新增门控 */
  ADD_GATE: 'goal:add-gate',
  /** 解决门控 */
  RESOLVE_GATE: 'goal:resolve-gate',
  /** 追加证据 */
  APPEND_EVIDENCE: 'goal:append-evidence',
  /** 判断 Goal 当前是否应推进（should-run） */
  SHOULD_RUN: 'goal:should-run',
  /** 检查是否允许花费 */
  CAN_SPEND: 'goal:can-spend',
  /** 记录花费 */
  SPEND_BUDGET: 'goal:spend-budget',
  /** 绑定会话到 Goal */
  BIND_SESSION: 'goal:bind-session',
  /** 解绑会话 */
  UNBIND_SESSION: 'goal:unbind-session',
  /** 查询会话绑定的 Goal */
  GET_SESSION_GOAL: 'goal:get-session-goal',
  /** 查询绑定到 Goal 的会话列表 */
  LIST_SESSIONS: 'goal:list-sessions',
} as const
