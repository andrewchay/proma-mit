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
  // Brief 回执
  LIST_BRIEF_RECEIPTS: 'project:list-brief-receipts',
  LIST_BRIEF_RECEIPTS_BY_TASK: 'project:list-brief-receipts-by-task',
  SEND_BRIEF: 'project:send-brief',
  TEST_DINGTALK_CONNECTION: 'project:test-dingtalk-connection',
  TEST_FEISHU_CONNECTION: 'project:test-feishu-connection',
  // 看板与进度
  GET_KANBAN_BOARD: 'project:get-kanban-board',
  GET_PROJECT_PROGRESS: 'project:get-project-progress',
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
  priority?: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: number
  /** 父任务 ID，存在时该任务即为子任务 */
  parentId?: string
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
  status?: 'pending' | 'in_progress' | 'completed'
  dueDate?: number
  subTasks?: SubTaskInput[]
  /** 父任务 ID，用于建立/解除父子关联 */
  parentId?: string | null
}

export interface CreateSubTaskInput {
  title: string
  description?: string
  assignee?: { userId: string; displayName: string }
  priority?: 'low' | 'medium' | 'high' | 'critical'
  dueDate?: number
}

export interface ListTasksFilterInput {
  status?: 'pending' | 'in_progress' | 'completed'
  assigneeUserId?: string
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
}

export interface KanbanBoardResult {
  draft: unknown[]
  pending: unknown[]
  in_progress: unknown[]
  completed: unknown[]
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
} as const

export interface CreateAgentEmployeeInput {
  name: string
  role: string
  avatar?: string
  description: string
  runtime?: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  channelId: string
  modelId?: string
  workspaceId?: string
  workflowId?: string
  systemPrompt?: string
  skills?: string[]
}

export interface UpdateAgentEmployeeInput {
  name?: string
  role?: string
  avatar?: string | null
  description?: string
  runtime?: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  channelId?: string
  modelId?: string | null
  workspaceId?: string | null
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
  workspaceId?: string
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

