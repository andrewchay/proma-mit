/**
 * 运行记录（Run Record）类型 —— P2-1 Context Hub 起点。
 *
 * 统一记录 Agent / Workflow / Automation 的运行事件，
 * 为 P2-2 Run Center 提供数据源。
 */

/** 运行记录条目（对应 AppEventEnvelope 五态） */
export interface RunRecord {
  /** 记录 ID（事件 id） */
  id: string
  /** 运行 ID（taskId：Agent sessionId / Workflow runId / Automation runId） */
  runId: string
  source: 'agent' | 'workflow' | 'automation' | 'bridge' | 'external'
  /** 运行标题 */
  title: string
  /** 运行状态（五态） */
  status: 'started' | 'progress' | 'waiting_action' | 'completed' | 'failed'
  /** 需要用户交互类型（waiting_action 时） */
  actionKind?: 'permission' | 'ask_user_question' | 'plan_review'
  /** 当前动作摘要 */
  detail?: string
  /** 关联会话 ID（打开/导航用） */
  sessionId?: string
  /** 关联 Goal id（长生命周期目标） */
  goalId?: string
  /** 时间戳 */
  timestamp: number
}

/** 运行记录查询输入 */
export interface RunRecordQuery {
  source?: 'agent' | 'workflow' | 'automation' | 'bridge' | 'external'
  status?: RunRecord['status']
  /** 限制条数 */
  limit?: number
  /** 起始时间（毫秒） */
  from?: number
}

/** IPC 通道 */
export const RUN_RECORD_IPC_CHANNELS = {
  /** 查询运行记录 */
  LIST: 'run-record:list',
  /** 清空运行记录 */
  CLEAR: 'run-record:clear',
} as const
