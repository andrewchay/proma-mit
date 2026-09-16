/**
 * 工作模块 IPC 通道常量与类型定义（项目管理 / 日程管家 / 日历同步）
 *
 * 由 ~/LLM/PAA 的 project / schedule / calendar-sync 模块迁移而来。
 */

// ============================================
// 1. 日程管家 — Schedule
// ============================================

export const SCHEDULE_IPC_CHANNELS = {
  /** 获取日程事件列表 */
  LIST_EVENTS: 'schedule:list-events',
  /** 获取单个日程事件 */
  GET_EVENT: 'schedule:get-event',
  /** 创建日程事件 */
  CREATE_EVENT: 'schedule:create-event',
  /** 更新日程事件 */
  UPDATE_EVENT: 'schedule:update-event',
  /** 删除日程事件 */
  DELETE_EVENT: 'schedule:delete-event',
  /** 批量创建日程事件 */
  BULK_CREATE_EVENTS: 'schedule:bulk-create-events',
  /** 获取即将到期的事件 */
  GET_UPCOMING_EVENTS: 'schedule:get-upcoming-events',
  /** Agent 自然语言查询日程 */
  AGENT_QUERY: 'schedule:agent-query',
  /** 获取任务列表 */
  LIST_TASKS: 'schedule:list-tasks',
  /** 获取单个任务 */
  GET_TASK: 'schedule:get-task',
  /** 创建任务 */
  CREATE_TASK: 'schedule:create-task',
  /** 更新任务 */
  UPDATE_TASK: 'schedule:update-task',
  /** 更新任务状态 */
  UPDATE_TASK_STATUS: 'schedule:update-task-status',
  /** 删除任务 */
  DELETE_TASK: 'schedule:delete-task',
  /** 检测日程冲突 */
  DETECT_CONFLICTS: 'schedule:detect-conflicts',
  /** 获取展开后的重复日程 */
  LIST_EVENTS_EXPANDED: 'schedule:list-events-expanded',
  /** 解析自然语言日程 */
  PARSE_NLP: 'schedule:parse-nlp',
  /** 从自然语言创建日程 */
  CREATE_FROM_NLP: 'schedule:create-from-nlp',
} as const

export interface ScheduleEventInput {
  title: string
  description?: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  category?: string
  tags?: string[]
  reminderMinutes?: number[]
  recurrence?: {
    frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
    interval?: number
    count?: number
    until?: string
    byDay?: string[]
  }
}

export interface ScheduleEventResult {
  id: string
  title: string
  description?: string
  startTime: string
  endTime: string
  allDay?: boolean
  location?: string
  category?: string
  tags?: string[]
  reminderMinutes?: number[]
  recurrence?: unknown
  source?: 'manual' | 'calendar-sync' | 'agent'
  createdAt: string
  updatedAt: string
}

export interface ScheduleFilterInput {
  startDate?: string
  endDate?: string
  category?: string
  tags?: string[]
  source?: string
  searchQuery?: string
}

export interface ScheduleAgentQueryInput {
  query: string
  userTimezone: string
  workHoursStart?: string
  workHoursEnd?: string
}

// ============================================
// 2. 日历同步 — Calendar Sync
// ============================================

export const CALENDAR_SYNC_IPC_CHANNELS = {
  /** 获取日历源列表 */
  LIST_SOURCES: 'calendar-sync:list-sources',
  /** 获取单个日历源 */
  GET_SOURCE: 'calendar-sync:get-source',
  /** 创建日历源 */
  CREATE_SOURCE: 'calendar-sync:create-source',
  /** 更新日历源 */
  UPDATE_SOURCE: 'calendar-sync:update-source',
  /** 删除日历源 */
  DELETE_SOURCE: 'calendar-sync:delete-source',
  /** 同步单个日历源 */
  SYNC_SOURCE: 'calendar-sync:sync-source',
  /** 同步所有日历源 */
  SYNC_ALL: 'calendar-sync:sync-all',
  /** 解决同步冲突 */
  RESOLVE_CONFLICT: 'calendar-sync:resolve-conflict',
  /** 获取上次同步时间 */
  GET_LAST_SYNC: 'calendar-sync:get-last-sync',
  /** 检查系统日历权限 */
  CHECK_PERMISSION: 'calendar-sync:check-permission',
  /** 请求系统日历权限 */
  REQUEST_PERMISSION: 'calendar-sync:request-permission',
  /** 读取系统日历 */
  READ_SYSTEM_CALENDAR: 'calendar-sync:read-system-calendar',
  /** 从系统日历同步 */
  SYNC_FROM_SYSTEM: 'calendar-sync:sync-from-system',
} as const

export interface CalendarSourceInput {
  name: string
  provider: 'google' | 'apple' | 'outlook' | 'local' | 'other'
  config: {
    clientId?: string
    credentialsPath: string
    calendarId?: string
    localPath?: string
  }
  enabled: boolean
  syncDirection: 'one-way-in' | 'one-way-out' | 'two-way'
}

export interface CalendarSourceResult {
  id: string
  name: string
  provider: string
  enabled: boolean
  syncDirection: string
  lastSyncAt?: string
  createdAt: string
}

export interface CalendarSyncResult {
  sourceId: string
  added: number
  updated: number
  deleted: number
  conflicts: number
  errors: string[]
  timestamp: string
}

// ============================================
// 3. 项目管理 — Project
// ============================================

export const PROJECT_IPC_CHANNELS = {
  // 项目 CRUD
  LIST_PROJECTS: 'project:list-projects',
  GET_PROJECT: 'project:get-project',
  CREATE_PROJECT: 'project:create-project',
  UPDATE_PROJECT: 'project:update-project',
  DELETE_PROJECT: 'project:delete-project',
  // 任务 CRUD
  LIST_TASKS: 'project:list-tasks',
  GET_TASK: 'project:get-task',
  CREATE_TASK: 'project:create-task',
  UPDATE_TASK: 'project:update-task',
  DELETE_TASK: 'project:delete-task',
  // 子任务
  CREATE_SUB_TASK: 'project:create-sub-task',
  LIST_SUB_TASKS: 'project:list-sub-tasks',
  // 独立执行 subTask（区别于 WBS 子 Task）
  CREATE_EXECUTION_SUB_TASK: 'project:create-execution-sub-task',
  LIST_EXECUTION_SUB_TASKS: 'project:list-execution-sub-tasks',
  UPDATE_EXECUTION_SUB_TASK: 'project:update-execution-sub-task',
  DELETE_EXECUTION_SUB_TASK: 'project:delete-execution-sub-task',
  LIST_DINGTALK_TODO_RETRIES: 'project:list-dingtalk-todo-retries',
  RETRY_DINGTALK_TODO: 'project:retry-dingtalk-todo',
  /** 丢弃一条孤儿/卡死的 outbox 重试（PH2 修复） */
  DISMISS_OUTBOX_EVENT: 'project:dismiss-outbox-event',
  // 任务依赖与阻塞
  LIST_TASK_DEPENDENCIES: 'project:list-task-dependencies',
  CREATE_TASK_DEPENDENCY: 'project:create-task-dependency',
  DELETE_TASK_DEPENDENCY: 'project:delete-task-dependency',
  LIST_TASK_BLOCKERS: 'project:list-task-blockers',
  LIST_PROJECT_WORK_ITEMS: 'project:list-project-work-items',
  LIST_MY_WORK: 'project:list-my-work',
  /** PH2-⑤：我发起/指派的任务 */
  LIST_TASKS_CREATED_BY: 'project:list-tasks-created-by',
  /** 日程视图：跨项目轻量任务（有 dueDate 且未完成） */
  LIST_ALL_PROJECT_TASKS_LITE: 'project:list-all-project-tasks-lite',
  /** AI 员工执行回写/活动变化 → 通知前端刷新项目数据（main→renderer） */
  TASK_ACTIVITY_CHANGED: 'project:task-activity-changed',
  LIST_PROJECT_ALERTS: 'project:list-project-alerts',
  LIST_PROJECT_ACTIVITIES: 'project:list-project-activities',
  GENERATE_PROJECT_SUMMARY: 'project:generate-summary',
  LIST_PROJECT_TEMPLATES: 'project:list-templates',
  CREATE_PROJECT_TEMPLATE: 'project:create-template',
  APPLY_PROJECT_TEMPLATE: 'project:apply-template',
  SEND_PROJECT_SUMMARY_DINGTALK: 'project:send-summary-dingtalk',
  SEND_PROJECT_SUMMARY_FEISHU: 'project:send-summary-feishu',
  // 任务草稿
  CREATE_TASK_DRAFT: 'project:create-task-draft',
  CONFIRM_TASK_DRAFT: 'project:confirm-task-draft',
  REJECT_TASK_DRAFT: 'project:reject-task-draft',
  // 会议纪要
  IMPORT_MEETING_NOTE: 'project:import-meeting-note',
  LIST_MEETING_NOTES: 'project:list-meeting-notes',
  GET_MEETING_NOTE: 'project:get-meeting-note',
  IMPORT_AND_EXTRACT: 'project:import-and-extract',
  // 钉钉文档自动拉取 → 任务提取
  FETCH_DINGTALK_DOC: 'project:fetch-dingtalk-doc',
  FETCH_FEISHU_DOC: 'project:fetch-feishu-doc',
  // Brief 回执
  LIST_BRIEF_RECEIPTS: 'project:list-brief-receipts',
  LIST_BRIEF_RECEIPTS_BY_TASK: 'project:list-brief-receipts-by-task',
  SEND_BRIEF: 'project:send-brief',
  TEST_DINGTALK_CONNECTION: 'project:test-dingtalk-connection',
  TEST_FEISHU_CONNECTION: 'project:test-feishu-connection',
  // 看板与进度
  GET_KANBAN_BOARD: 'project:get-kanban-board',
  GET_PROJECT_PROGRESS: 'project:get-project-progress',
  // 任务状态定义（State 分组，借鉴 Plane：跨状态逻辑只认语义组）
  LIST_TASK_STATUSES: 'project:list-task-statuses',
  CREATE_TASK_STATUS: 'project:create-task-status',
  UPDATE_TASK_STATUS: 'project:update-task-status',
  DELETE_TASK_STATUS: 'project:delete-task-status',
  REORDER_TASK_STATUSES: 'project:reorder-task-statuses',
  // 任务拖拽排序（中点法；一次拖拽可同时改状态与位置）
  REORDER_TASK: 'project:reorder-task',
  // 任务级 token 配额：查询任务关联执行的累计消耗（配额刹车依据）
  GET_TASK_TOKEN_USAGE: 'project:get-task-token-usage',
  // 项目级 AI 成本聚合：本项目所有 agent 执行的 token/费用（按员工分组）
  GET_PROJECT_AI_COST: 'project:get-project-ai-cost',
  // 用户映射
  SAVE_USER_MAPPING: 'project:save-user-mapping',
  GET_USER_MAPPING: 'project:get-user-mapping',
  LIST_USER_MAPPINGS: 'project:list-user-mappings',
  DELETE_USER_MAPPING: 'project:delete-user-mapping',
  // 外部同步
  SYNC_TASK: 'project:sync-task',
  GET_SYNC_STATUS: 'project:get-sync-status',
  // 风险评估
  ASSESS_TASK_RISK: 'project:assess-task-risk',
  SAVE_COMPLETION_NOTES: 'project:save-completion-notes',
  // 外部轮询
  POLL_START: 'project:poll-start',
  POLL_STOP: 'project:poll-stop',
  POLL_STATUS_CHANGED: 'project:poll-status-changed',
  // 项目风险报告
  GENERATE_RISK_REPORT: 'project:generate-risk-report',
  // 外部通讯录搜索
  SEARCH_CONTACTS_ALL: 'project:search-contacts-all',
  // 成员同步（PH1-A）
  SYNC_MEMBERS_ALL: 'project:sync-members-all',
  SYNC_MEMBERS_FEISHU: 'project:sync-members-feishu',
  SYNC_MEMBERS_DINGTALK: 'project:sync-members-dingtalk',
  LIST_MEMBERS: 'project:list-members',
  GET_MEMBER: 'project:get-member',
  /** 按名字确保成员存在（不存在则建 human 成员），供任务指派统一写 member_id */
  ENSURE_MEMBER_BY_NAME: 'project:ensure-member-by-name',
  // 成员目录聚合（PH1-B）
  LIST_MEMBER_DIRECTORY: 'project:list-member-directory',
  COUNT_MEMBER_DIRECTORY: 'project:count-member-directory',
} as const

export interface ProjectInput {
  title: string
  description: string
}

export interface ProjectUpdateInput {
  title?: string
  description?: string
  status?: 'planning' | 'active' | 'completed' | 'cancelled'
}

export interface TaskInput {
  title: string
  description: string
  assignee?: { userId: string; displayName: string }
  /** 负责人对应的统一成员目录 ID（优先于自由文本 assignee） */
  assigneeMemberId?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: number
  /** 父任务 ID，存在时该任务即为子任务 */
  parentId?: string
  /** AI 员工执行 token 配额（可选）：累计消耗超限即中止执行，任务回退待处理 */
  tokenBudget?: number
}

export interface SubTaskInput {
  id: string
  title: string
  status: 'pending' | 'completed'
  createdAt: number
}

export interface TaskUpdateInput {
  title?: string
  description?: string
  assignee?: { userId: string; displayName: string }
  priority?: 'low' | 'medium' | 'high' | 'critical'
  /** 任务状态 id：预置五态（draft/pending/in_progress/paused/completed）或项目自定义状态 id */
  status?: string
  dueDate?: number
  subTasks?: SubTaskInput[]
  /** 父任务 ID，用于建立/解除父子关联 */
  parentId?: string | null
  /** AI 员工执行 token 配额（可选）：累计消耗超限即中止执行 */
  tokenBudget?: number
}

export interface CreateSubTaskInput {
  title: string
  description?: string
  assignee?: { userId: string; displayName: string }
  priority?: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: number
}

export interface ListTasksFilterInput {
  status?: string
  /** 按语义组过滤（backlog/unstarted/started/completed/cancelled/triage） */
  statusGroup?: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' | 'triage'
  assigneeUserId?: string
  includeSubTasks?: boolean
  includeDrafts?: boolean
}

/** 项目级 AI 成本聚合（配额总览）：按员工分组的 token/费用消耗 */
export interface ProjectAiCostResult {
  projectId: string
  totalTokens: number
  totalCostUsd: number
  /** 有配额且已超限的任务清单（配额刹车记录） */
  overBudgetTasks: Array<{ taskId: string; title: string; budget: number; used: number }>
  /** 按员工分组的消耗 */
  byAgent: Array<{ agentId: string; agentName: string; tokens: number; costUsd: number; taskCount: number }>
}

/** 任务拖拽排序输入：位置由邻居表达（after=落点上方邻居/before=落点下方邻居，都不给=追加到列尾；两邻居分别定位，任一命中即采用），跨列时给 newStatusId */
export interface ReorderTaskInput {
  afterTaskId?: string
  beforeTaskId?: string
  newStatusId?: string
}

/** 排序结果：被移动任务 + 触发整列重编号时一并改写的任务（task 结构与主进程 Task 对齐，见 preload 泛型） */
export interface ReorderTaskResult {
  task: unknown
  rewrittenTasks: unknown[]
}

export interface MeetingNoteInput {
  title: string
  rawContent: string
}

export interface UserMappingInput {
  paaUserId: string
  feishuUserId?: string
  dingtalkUserId?: string
  displayName: string
  feishuUnionId?: string
  dingTalkUnionId?: string
}

/** 状态语义组（与主进程 project-types.TaskStateGroup 对齐） */
export type ProjectTaskStateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' | 'triage'

/** 项目任务状态定义（每项目独立可自定义；预置五态 id 固定为 draft/pending/in_progress/paused/completed） */
export interface ProjectTaskStatus {
  id: string
  projectId: string
  name: string
  stateGroup: ProjectTaskStateGroup
  position: number
  color?: string
  wipLimit?: number
  isBuiltin: boolean
  isDefault: boolean
  createdAt: number
}

export interface ProjectTaskStatusInput {
  name: string
  stateGroup: ProjectTaskStateGroup
  color?: string
  wipLimit?: number
  afterStatusId?: string
}

export interface ProjectTaskStatusUpdateInput {
  name?: string
  stateGroup?: ProjectTaskStateGroup
  color?: string
  wipLimit?: number
}

/** 看板列：一个状态 + 该状态下的任务 */
export interface KanbanColumnResult {
  status: ProjectTaskStatus
  tasks: unknown[]
}

export interface KanbanBoardResult {
  columns: KanbanColumnResult[]
}

export interface ProjectProgressResult {
  total: number
  completed: number
  percentage: number
}

// ============================================
// 4. AI 员工（Agent Employee）— P0
// ============================================

export const AGENT_EMPLOYEE_IPC_CHANNELS = {
  /** AI 员工列表 */
  LIST_EMPLOYEES: 'agent-employee:list',
  /** 获取单个 AI 员工 */
  GET_EMPLOYEE: 'agent-employee:get',
  /** 创建 AI 员工 */
  CREATE_EMPLOYEE: 'agent-employee:create',
  /** 更新 AI 员工 */
  UPDATE_EMPLOYEE: 'agent-employee:update',
  /** 删除 AI 员工 */
  DELETE_EMPLOYEE: 'agent-employee:delete',
  /** 查询某任务/子任务的执行记录 */
  LIST_EXECUTIONS_BY_ENTITY: 'agent-employee:list-executions-by-entity',
  /** 查询某 AI 员工的执行记录 */
  LIST_EXECUTIONS_BY_AGENT: 'agent-employee:list-executions-by-agent',
  /** 停止仍在排队或运行中的执行；不会删除 worktree 或交付证据。 */
  CANCEL_EXECUTION: 'agent-employee:cancel-execution',
  /** 查询员工能力版本。 */
  LIST_CAPABILITY_VERSIONS: 'agent-employee:list-capability-versions',
  /** 查询员工可审计学习样本。 */
  LIST_LEARNING_SAMPLES: 'agent-employee:list-learning-samples',
  /** 人工排除一条样本，禁止其进入演化输入。 */
  EXCLUDE_LEARNING_SAMPLE: 'agent-employee:exclude-learning-sample',
  /** 审核学习样本摘要并更新脱敏状态。 */
  REVIEW_LEARNING_SAMPLE: 'agent-employee:review-learning-sample',
} as const

export interface CreateAgentEmployeeInput {
  name: string
  role: string
  avatar?: string
  description: string
  runtime?: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  channelId: string
  modelId?: string
  /** 兼容旧档案的单个默认工作区；新配置优先使用 workspaceIds。 */
  workspaceId?: string
  /** AI 员工作为角色可服务的工作区集合；执行任务须从中明确选择。 */
  workspaceIds?: string[]
  /** 研发配置启用独立 Git worktree；缺省为普通员工。 */
  executionProfile?: 'general' | 'development'
  /** 研发配置的 Runtime 权限；缺省 safe，auto 仍可能等待审批。 */
  permissionMode?: 'safe' | 'auto'
  workflowId?: string
  systemPrompt?: string
  skills?: string[]
}

export interface CancelAgentExecutionResult {
  id: string
  status: 'cancelled'
}

export interface UpdateAgentEmployeeInput {
  name?: string
  role?: string
  avatar?: string | null
  description?: string
  runtime?: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  channelId?: string
  modelId?: string | null
  /** 兼容旧档案的单个默认工作区；新配置优先使用 workspaceIds。 */
  workspaceId?: string | null
  /** AI 员工作为角色可服务的工作区集合；传入时整体替换。 */
  workspaceIds?: string[]
  /** 研发配置启用独立 Git worktree；缺省为普通员工。 */
  executionProfile?: 'general' | 'development'
  /** 研发配置的 Runtime 权限；缺省 safe，auto 仍可能等待审批。 */
  permissionMode?: 'safe' | 'auto'
  workflowId?: string | null
  systemPrompt?: string | null
  skills?: string[]
  enabled?: boolean
}

export interface AgentEmployeeResult {
  id: string
  name: string
  role: string
  avatar?: string
  description: string
  runtime: string
  channelId: string
  modelId?: string
  /** 兼容旧档案的首选工作区。 */
  workspaceId?: string
  /** AI 员工作为角色可服务的工作区集合。 */
  workspaceIds?: string[]
  /** 研发配置启用独立 Git worktree；缺省为普通员工。 */
  executionProfile?: 'general' | 'development'
  /** 研发配置的 Runtime 权限；缺省 safe，auto 仍可能等待审批。 */
  permissionMode?: 'safe' | 'auto'
  workflowId?: string
  systemPrompt?: string
  skills: string[]
  enabled: boolean
  totalTasks: number
  completedTasks: number
  avgDurationMs?: number
  failureCount: number
  createdAt: number
  updatedAt: number
}

export interface AgentExecutionResult {
  id: string
  projectId: string
  entityType: 'task' | 'subTask'
  entityId: string
  agentId: string
  sessionId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'
  prompt: string
  resultSummary?: string
  outputFiles: string[]
  riskLevel?: string
  error?: string
  requestedPermissions: string[]
  lastHeartbeatAt?: number
  startedAt: number
  completedAt?: number
  /** 调度时冻结的能力版本；旧执行记录可能缺失。 */
  capabilityVersionIds?: string[]
  capabilityContentHash?: string
}

// ===== 成员（PH1-A） =====

export interface MemberResult {
  memberId: string
  kind: 'human' | 'agent' | 'bot'
  displayName: string
  /** 角色/描述（AI 员工 role / bot 平台等） */
  role?: string
  /** 来源平台标识（bot 用） */
  platform?: 'feishu' | 'dingtalk' | 'wechat'
  feishuUserId?: string
  feishuUnionId?: string
  dingtalkUserId?: string
  dingtalkUnionId?: string
  department?: string
  source: 'sync' | 'manual'
  active: boolean
  lastSyncedAt?: number
  createdAt: number
}

export interface MemberSyncResult {
  platform: 'feishu' | 'dingtalk'
  pulled: number
  inserted: number
  merged: number
  failed: number
  error?: string
}

export interface MemberSyncAllResult {
  feishu: MemberSyncResult
  dingtalk: MemberSyncResult
  startedAt: number
  finishedAt: number
}


// ============================================
// 新媒体运营本地工作台
// ============================================

export const NEW_MEDIA_IPC_CHANNELS = {
  LIST_DRAFTS: 'new-media:list-drafts',
  CREATE_DRAFT: 'new-media:create-draft',
  LIST_PUBLICATION_JOBS: 'new-media:list-publication-jobs',
  SCHEDULE_PUBLICATION: 'new-media:schedule-publication',
  LIST_ENGAGEMENTS: 'new-media:list-engagements',
  INGEST_ENGAGEMENT: 'new-media:ingest-engagement',
  CREATE_REPLY_DRAFT: 'new-media:create-reply-draft',
  LIST_LISTENING_QUERIES: 'new-media:list-listening-queries',
  CREATE_LISTENING_QUERY: 'new-media:create-listening-query',
  LIST_MENTIONS: 'new-media:list-mentions',
  INGEST_MENTION: 'new-media:ingest-mention',
  GET_LISTENING_DIGEST: 'new-media:get-listening-digest',
  LIST_METRIC_SNAPSHOTS: 'new-media:list-metric-snapshots',
  INGEST_METRIC_SNAPSHOT: 'new-media:ingest-metric-snapshot',
  GET_SOCIAL_REPORT: 'new-media:get-social-report',
  LIST_TRENDS: 'new-media:list-trends',
  INGEST_TREND: 'new-media:ingest-trend',
  GET_TREND_OPPORTUNITIES: 'new-media:get-trend-opportunities',
  LIST_CONTROLLED_ACTIONS: 'new-media:list-controlled-actions',
  REQUEST_CONTROLLED_ACTION: 'new-media:request-controlled-action',
  APPROVE_CONTROLLED_ACTION: 'new-media:approve-controlled-action',
  SIMULATE_CONTROLLED_ACTION: 'new-media:simulate-controlled-action',
  GET_CONTROLLED_ACTION_AUDIT: 'new-media:get-controlled-action-audit',
} as const

export type NewMediaPlatform = 'xiaohongshu' | 'wechat-official-account'

export interface NewMediaContentDraft {
  id: string
  sourceText: string
  platformCopies: Partial<Record<NewMediaPlatform, { title: string; body: string; hashtags: string[] }>>
  createdAt: number
}

export interface NewMediaPublicationJob {
  id: string
  draftId: string
  platform: NewMediaPlatform
  accountId: string
  scheduledAt: number
  status: 'draft' | 'scheduled' | 'pending_approval' | 'published' | 'failed'
  approvalRequired: true
  createdAt: number
}

export interface NewMediaEngagementItem {
  id: string
  platform: NewMediaPlatform
  channel: 'comment' | 'direct-message'
  author: string
  text: string
  intent: 'praise' | 'question' | 'complaint' | 'cooperation' | 'spam' | 'other'
  sentiment: 'positive' | 'neutral' | 'negative'
  priority: 'low' | 'normal' | 'high' | 'urgent'
  requiresHumanReview: boolean
  createdAt: number
}
export interface NewMediaReplyDraft { id: string; engagementId: string; text: string; status: 'draft'; createdAt: number }
export interface NewMediaListeningQuery { id: string; keywords: string[]; createdAt: number }
export interface NewMediaMention { id: string; queryId: string; platform: NewMediaPlatform; sourceUrl: string; text: string; sentiment: 'positive' | 'neutral' | 'negative'; risk: 'none' | 'watch' | 'high'; createdAt: number }
export interface NewMediaListeningDigest { query: NewMediaListeningQuery; total: number; sentiment: Record<'positive' | 'neutral' | 'negative', number>; highRiskMentions: NewMediaMention[] }
export interface NewMediaMetricSnapshot { id: string; platform: NewMediaPlatform; contentId: string; capturedAt: number; impressions: number; engagements: number; followersGained: number }
export interface NewMediaSocialReport { periodStart: number; periodEnd: number; totalImpressions: number; totalEngagements: number; engagementRate: number; followersGained: number; byPlatform: Partial<Record<NewMediaPlatform, { impressions: number; engagements: number; followersGained: number }>> }
export interface NewMediaTrendItem { id: string; title: string; summary: string; source: string; observedAt: number; heat: number; relatedKeywords: string[]; risk: 'low' | 'medium' | 'high' }
export interface NewMediaTrendOpportunity { trend: NewMediaTrendItem; relevanceScore: number; recommendation: 'act' | 'monitor' | 'avoid'; rationale: string }

export interface NewMediaControlledAction {
  id: string
  kind: 'publish' | 'send-reply'
  platform: NewMediaPlatform
  targetId: string
  summary: string
  status: 'pending_approval' | 'approved' | 'simulated' | 'rejected'
  requestedAt: number
  approvedAt?: number
  approvedBy?: string
  executedAt?: number
  simulationReceipt?: string
}

export interface NewMediaAuditEntry {
  id: string
  actionId: string
  event: 'requested' | 'approved' | 'simulated' | 'rejected'
  actor: string
  createdAt: number
  detail: string
}

// ============================================
// 营销能力 — Influencer（达人）包
// ============================================

export const INFLUENCER_IPC_CHANNELS = {
  /** 获取订阅状态 */
  GET_SUBSCRIBED: 'influencer:get-subscribed',
  /** 了解达人库 */
  LIST_TALENTS: 'influencer:list-talents',
  GET_TALENT: 'influencer:get-talent',
  CREATE_TALENT: 'influencer:create-talent',
  UPDATE_TALENT: 'influencer:update-talent',
  DELETE_TALENT: 'influencer:delete-talent',
  /** brief */
  LIST_BRIEFS: 'influencer:list-briefs',
  CREATE_BRIEF: 'influencer:create-brief',
  /** 达人稿件审核 */
  LIST_DRAFTS: 'influencer:list-drafts',
  GET_DRAFT: 'influencer:get-draft',
  CREATE_DRAFT: 'influencer:create-draft',
  UPDATE_DRAFT: 'influencer:update-draft',
  DELETE_DRAFT: 'influencer:delete-draft',
} as const

export interface InfluencerTalent {
  id: string
  name: string
  platform: string
  handle?: string
  region?: string
  tags?: string[]
  status: 'active' | 'paused' | 'blacklist'
  createdAt: string
  updatedAt: string
}

export interface InfluencerBrief {
  id: string
  talentId: string
  version?: string
  product: string
  direction?: unknown
  accept: 'pending' | 'accepted' | 'rejected'
  createdAt: string
  updatedAt: string
}

/** 达人稿件（含三态审核卡） */
export interface InfluencerDraft {
  id: string
  briefId: string
  talentId: string
  source: string
  sourceRef?: string
  draftType: string
  reviewCard: 'red' | 'yellow' | 'green'
  reviewDetail?: unknown
  status: 'submitted' | 'reviewing' | 'approved' | 'rejected' | 'rework'
  reviewer?: string
  createdAt: string
  updatedAt: string
}

// ============================================
// 营销能力 — Paid Media（广告投放）包
// ============================================

export const PAID_MEDIA_IPC_CHANNELS = {
  /** 获取订阅状态 */
  GET_SUBSCRIBED: 'paid-media:get-subscribed',
  /** 投放 Campaign */
  LIST_CAMPAIGNS: 'paid-media:list-campaigns',
  GET_CAMPAIGN: 'paid-media:get-campaign',
  CREATE_CAMPAIGN: 'paid-media:create-campaign',
  UPDATE_CAMPAIGN: 'paid-media:update-campaign',
  DELETE_CAMPAIGN: 'paid-media:delete-campaign',
  /** 调控建议 + 审批 */
  LIST_CONTROL_ACTIONS: 'paid-media:list-control-actions',
  CREATE_CONTROL_ACTION: 'paid-media:create-control-action',
  UPDATE_CONTROL_ACTION: 'paid-media:update-control-action',
  /** 调控规则 */
  LIST_RULES: 'paid-media:list-rules',
  CREATE_RULE: 'paid-media:create-rule',
  UPDATE_RULE: 'paid-media:update-rule',
} as const

export interface PaidCampaign {
  id: string
  name: string
  channel?: string
  region?: string
  platform?: string
  adType?: string
  deliverTarget?: string
  budgetDay?: number
  budgetStatus: 'pending' | 'approved' | 'rejected'
  status: 'draft' | 'active' | 'paused' | 'archived'
  goalRoi?: number
  createdAt: string
  updatedAt: string
}

export interface PaidControlAction {
  id: string
  campaignId: string
  actionType: string
  detail?: unknown
  status: 'pending' | 'approved' | 'rejected' | 'executed'
  reviewer?: string
  createdAt: string
  updatedAt: string
}

export interface PaidRule {
  id: string
  channel?: string
  kind: 'redline' | 'business' | 'hint'
  name: string
  params?: unknown
  enabled: boolean
  updatedAt: string
}

// ============================================
// 营销能力 — 共享素材生产
// ============================================

export const CREATIVE_IPC_CHANNELS = {
  /** 素材项目 */
  LIST_PROJECTS: 'creative:list-projects',
  CREATE_PROJECT: 'creative:create-project',
  /** 素材成品 */
  LIST_ASSETS: 'creative:list-assets',
  DELETE_ASSET: 'creative:delete-asset',
  RENAME_ASSET: 'creative:rename-asset',
  /** 生成任务 */
  LIST_TASKS: 'creative:list-tasks',
  CREATE_TASK: 'creative:create-task',
  GET_TASK: 'creative:get-task',
  /** 视频：分镜生成 */
  GEN_STORYBOARD: 'creative:gen-storyboard',
  /** 视频：运行生成流水线 */
  RUN_PIPELINE: 'creative:run-pipeline',
  /** 视频：探测元数据 */
  PROBE_ASSET: 'creative:probe-asset',
  /** 视频：校验引擎凭据 */
  CHECK_CREDENTIAL: 'creative:check-credential',
} as const

export interface CreativeProject {
  id: string
  name: string
  client: 'influencer' | 'paid' | 'general'
  version?: string
  tags?: string[]
  createdAt: string
  updatedAt: string
}

export interface CreativeAsset {
  id: string
  projectId?: string
  media: 'image' | 'video'
  platform?: string
  resolution?: string
  status: 'ready' | 'processing' | 'failed'
  createdAt: string
}
