/**
 * 行为采集领域类型
 *
 * 为专业版分析能力提供数据基础。当前分析引擎只有日程与任务两个数据源，
 * 无法支撑学习曲线、工作节律与协作分析，因此需要先做采集层。
 *
 * 设计原则：
 * - **被动优先**：knowledge / focus / collaboration 三类事件由既有动作
 *   （打开笔记、Agent 会话、日程会议）自动记录，不要求用户额外输入。
 * - **敏感隔离**：emotion 需要用户主动打卡，属敏感数据，存储在独立目录
 *   （见 telemetry-mood 路径），默认关闭，必须显式开启才会记录。
 * - **只记事实不记内容**：事件只保存「做了什么、什么时候」，不保存笔记
 *   正文、会话内容、情绪描述以外的自由文本，避免把采集层变成内容仓库。
 */

// ===== 事件类别 =====

/**
 * 采集事件类别。
 *
 * knowledge / focus / collaboration 为被动采集（默认开启）；
 * emotion 为主动打卡（默认关闭，需显式开启）。
 */
export type TelemetryCategory = 'knowledge' | 'focus' | 'collaboration' | 'emotion'

/** 各类事件的默认开启状态（被动采集开启，主动打卡关闭） */
export const TELEMETRY_DEFAULT_ENABLED: Record<TelemetryCategory, boolean> = {
  knowledge: true,
  focus: true,
  collaboration: true,
  emotion: false,
}

/** 需要显式开启的敏感类别 */
export const TELEMETRY_SENSITIVE_CATEGORIES: TelemetryCategory[] = ['emotion']

export function isSensitiveCategory(category: TelemetryCategory): boolean {
  return TELEMETRY_SENSITIVE_CATEGORIES.includes(category)
}

// ===== 事件类型 =====

/** 知识学习类事件 */
export type KnowledgeEventType =
  /** 打开笔记阅读 */
  | 'note_opened'
  /** 编辑并保存笔记 */
  | 'note_saved'
  /** 笔记被 Agent 作为上下文引用 */
  | 'note_referenced_by_agent'

/** 工作节律类事件 */
export type FocusEventType =
  /** Agent 会话开始 */
  | 'session_started'
  /** Agent 会话结束（含时长） */
  | 'session_finished'
  /** 单个工具调用完成 */
  | 'tool_invoked'

/** 社交协作类事件 */
export type CollaborationEventType =
  /** 参与日程事件（会议/沟通类） */
  | 'meeting_attended'

/** 情绪类事件（主动打卡） */
export type EmotionEventType =
  /** 一次情绪记录 */
  | 'mood_logged'

export type TelemetryEventType =
  | KnowledgeEventType
  | FocusEventType
  | CollaborationEventType
  | EmotionEventType

// ===== 事件结构 =====

/**
 * 单条采集事件。
 *
 * 刻意保持字段最小：`value` 只放数值型度量（时长秒数、情绪分值等），
 * `meta` 只放短标识（笔记 id、会话 id、日程 id），不承载正文内容。
 */
export interface TelemetryEvent {
  /** 事件 id（用于去重与删除） */
  id: string
  category: TelemetryCategory
  type: TelemetryEventType
  /** 事件发生时间（ISO 8601） */
  at: string
  /**
   * 数值度量。
   * - session_finished：会话时长（秒）
   * - tool_invoked：固定 1（用于计数）
   * - meeting_attended：会议时长（分钟）
   * - mood_logged：情绪分值 1-5
   */
  value?: number
  /** 短标识元数据（id 引用，不含正文） */
  meta?: Record<string, string | number>
}

/** 写入事件时的输入（id 与时间由服务层补齐） */
export interface TelemetryEventInput {
  category: TelemetryCategory
  type: TelemetryEventType
  /** 不传则用当前时间 */
  at?: string
  value?: number
  meta?: Record<string, string | number>
}

// ===== 聚合结果 =====

/** 单日聚合 */
export interface TelemetryDailySummary {
  /** 日期（YYYY-MM-DD，本地时区） */
  date: string
  /** 各类事件计数 */
  counts: Partial<Record<TelemetryEventType, number>>
  /** 知识类：当天打开与保存的笔记数（去重） */
  notesTouched: number
  /** 节律类：当天专注总时长（秒） */
  focusSeconds: number
  /** 协作类：当天会议总时长（分钟） */
  meetingMinutes: number
  /** 情绪类：当天打卡次数 */
  moodCheckins: number
  /** 情绪类：当天平均分值（无打卡时为 undefined） */
  moodAverage?: number
}

/** 聚合总览 */
export interface TelemetryOverview {
  /** 采集覆盖的日期区间（无数据时为空） */
  range?: { start: string; end: string }
  /** 事件总数 */
  totalEvents: number
  /** 按日汇总（按日期升序，仅含实际有数据的日期） */
  daily: TelemetryDailySummary[]
  /**
   * 连续记录天数（从今天或最近有数据的一天倒推）。
   * 用于「知识回顾」「打卡坚持度」这类指标。
   */
  currentStreak: number
  /** 各类别的事件计数 */
  categoryTotals: Record<TelemetryCategory, number>
}

/** 采集开关状态 */
export interface TelemetrySettings {
  /** 各类别是否启用采集 */
  enabled: Record<TelemetryCategory, boolean>
  /** 事件保留天数（0 表示不自动清理） */
  retentionDays: number
}

/** 采集数据量信息（供设置页展示与清理确认） */
export interface TelemetryStats {
  /** 事件文件总大小（字节） */
  eventBytes: number
  /** 事件条数 */
  eventCount: number
  /** 最早与最新事件时间 */
  oldestAt?: string
  newestAt?: string
  /** 敏感数据的条数与大小（独立统计） */
  sensitive: { count: number; bytes: number }
}

// ===== 情绪打卡 =====

/** 情绪打卡输入 */
export interface MoodCheckinInput {
  /** 情绪分值 1（很低）到 5（很好） */
  score: number
  /** 可选标签，如「专注」「疲惫」（短字符串，不承载长文本） */
  tags?: string[]
}

export const TELEMETRY_IPC_CHANNELS = {
  // 采集设置
  /** 获取采集设置 */
  GET_SETTINGS: 'telemetry:get-settings',
  /** 更新采集开关 */
  UPDATE_SETTINGS: 'telemetry:update-settings',
  /** 获取采集统计（数据量、时间范围） */
  GET_STATS: 'telemetry:get-stats',
  /** 获取聚合总览 */
  GET_OVERVIEW: 'telemetry:get-overview',
  /** 清空全部采集数据 */
  CLEAR_ALL: 'telemetry:clear-all',
  /** 仅清空敏感数据（情绪打卡） */
  CLEAR_SENSITIVE: 'telemetry:clear-sensitive',

  // 主动打卡
  /** 记录一次情绪打卡 */
  LOG_MOOD: 'telemetry:log-mood',
  /** 获取最近的打卡记录（用于打卡页回显） */
  LIST_MOOD: 'telemetry:list-mood',
} as const
