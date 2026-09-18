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
  /** 查询按冻结版本归因的生产观察摘要。 */
  GET_CAPABILITY_OBSERVATIONS: 'agent-employee:get-capability-observations',
  /** 带原因人工回滚当前 active 版本。 */
  ROLLBACK_CAPABILITY_VERSION: 'agent-employee:rollback-capability-version',
  /** 查询能力版本回滚审计。 */
  LIST_CAPABILITY_ROLLBACK_AUDITS: 'agent-employee:list-capability-rollback-audits',
  /** 手动运行受控评测；通过门禁后只创建待审批候选。 */
  RUN_CAPABILITY_EVALUATION: 'agent-employee:run-capability-evaluation',
  /** 查询带时间窗的版本健康指标。 */
  GET_CAPABILITY_HEALTH: 'agent-employee:get-capability-health',
  /** 查询 Canary 分流配置。 */
  LIST_CAPABILITY_CANARY: 'agent-employee:list-capability-canary',
  /** 显式启用 Canary 分流（默认关闭）。 */
  ENABLE_CAPABILITY_CANARY: 'agent-employee:enable-capability-canary',
  /** 关闭或暂停 Canary 分流；不自动回滚版本。 */
  DISABLE_CAPABILITY_CANARY: 'agent-employee:disable-capability-canary',
  /** 查询能力版本依赖关系（显式 ID）。 */
  GET_CAPABILITY_DEPENDENCY_GRAPH: 'agent-employee:get-capability-dependency-graph',
  /** 在保存前校验一组组合能力，不写入任何数据。 */
  PREVIEW_CAPABILITY_CONFLICTS: 'agent-employee:preview-capability-conflicts',
  /** 读取治理策略配置。 */
  GET_GOVERNANCE_POLICY: 'agent-employee:get-governance-policy',
  /** 更新治理策略配置并记录变更审计。 */
  UPDATE_GOVERNANCE_POLICY: 'agent-employee:update-governance-policy',
  /** 读取治理策略变更审计。 */
  LIST_GOVERNANCE_AUDITS: 'agent-employee:list-governance-audits',
  /** 预览样本保留期影响，不删除数据。 */
  PREVIEW_SAMPLE_RETENTION: 'agent-employee:preview-sample-retention',
  /** 显式删除指定样本；调用方需先展示预览并确认。 */
  DELETE_LEARNING_SAMPLES: 'agent-employee:delete-learning-samples',
  /** 读取能力演化运营台账。 */
  GET_EVOLUTION_LEDGER: 'agent-employee:get-evolution-ledger',
  /** 导出脱敏演化包（不含样本摘要、路径、密钥）。 */
  EXPORT_EVOLUTION_PACKAGE: 'agent-employee:export-evolution-package',
  /** 校验导入包；不自动激活任何内容。 */
  VALIDATE_EVOLUTION_PACKAGE: 'agent-employee:validate-evolution-package',
  /** 预览回滚影响，不修改数据。 */
  PREVIEW_CAPABILITY_ROLLBACK: 'agent-employee:preview-capability-rollback',
  /** 读取版本健康告警。 */
  GET_CAPABILITY_ALERTS: 'agent-employee:get-capability-alerts',
  /** 扫描样本摘要中的疑似敏感内容（只提示）。 */
  SCAN_SAMPLE_CONTENT: 'agent-employee:scan-sample-content',
  /** 读取评测定义版本历史。 */
  LIST_BENCHMARK_VERSION_HISTORY: 'agent-employee:list-benchmark-version-history',
  /** 读取或更新周期扫描调度（默认关闭）。 */
  GET_SCAN_SCHEDULE: 'agent-employee:get-scan-schedule',
  UPDATE_SCAN_SCHEDULE: 'agent-employee:update-scan-schedule',
  /** 立即运行一次到点扫描（仅本地只读）。 */
  RUN_SCAN_IF_DUE: 'agent-employee:run-scan-if-due',
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

export interface AgentEmployeeCapabilityObservationResult {
  versionId: string
  executionCount: number
  completedCount: number
  failedCount: number
  cancelledCount: number
  staleCount: number
  acceptedSamples: number
  changesRequestedSamples: number
  failedSamples: number
  cancelledSamples: number
  pendingSamples: number
  sanitizedSamples: number
  excludedSamples: number
  lastExecutedAt?: number
}

export interface AgentEmployeeCapabilityRollbackAuditResult {
  id: string
  agentId: string
  scope: 'role' | 'workspace'
  workspaceId?: string
  fromVersionId: string
  toVersionId?: string
  reason: string
  actorId: string
  createdAt: number
}

export interface AgentEmployeeCapabilityHealthResult {
  versionId: string
  windowDays: number
  executionCount: number
  reworkRate: number | null
  failureRate: number | null
  cancellationRate: number | null
  decidedSampleCount: number
  sampleSufficient: boolean
  lastExecutedAt?: number
  comparisonVersionId?: string
  reworkRateDelta?: number | null
  failureRateDelta?: number | null
  comparisonComparable: boolean
}

export interface AgentEmployeeCanaryConfigResult {
  agentId: string
  scope: 'role' | 'workspace'
  workspaceId?: string
  candidateVersionId: string
  percent: number
  enabled: boolean
  maxFailureRate: number
  maxReworkRate: number
  pausedAt?: number
  pausedReason?: string
  createdAt: number
  updatedAt: number
}

export interface CapabilityConflictFindingResult {
  severity: 'blocking' | 'advisory'
  code: 'governance_override' | 'contradictory_constraint' | 'duplicate_rule'
  message: string
  evidence: string
}

export interface AgentEmployeeCapabilityDependencyGraphResult {
  nodes: Array<{ id: string; scope: string; workspaceId?: string; versionNumber: number; status: string; parentVersionId?: string }>
  blockedBy: Array<{ workspaceVersionId: string; roleVersionId: string }>
}

export interface EmployeeCapabilityGovernancePolicyResult {
  minSanitizedSamples: number
  cooldownDays: number
  dailyRecommendationBudget: number
  maxConcurrentEvaluations: number
  maxCanaryPercent: number
  defaultMaxFailureRate: number
  defaultMaxReworkRate: number
  sampleRetentionDays: number | null
  auditRetentionDays: number | null
}

export interface EmployeeCapabilityGovernanceAuditResult {
  id: string
  field: string
  previousValue: number | null
  nextValue: number | null
  actorId: string
  createdAt: number
}

export interface AgentEmployeeSampleRetentionPreviewResult {
  total: number
  expired: number
  expiredIds: string[]
  cutoff?: number
}

export interface AgentEmployeeEvolutionLedgerEntryResult {
  agentId: string
  agentName: string
  versions: { total: number; active: number; superseded: number; rolledBack: number }
  samples: { total: number; pending: number; sanitized: number; excluded: number; cancelled: number }
  decisions: { approved: number; rejected: number; pending: number }
  rollbacks: number
  observations: { executionCount: number; reworkRate: number | null; failureRate: number | null; decidedSampleCount: number; sampleSufficient: boolean }
  evaluationCostUsd: number
  reviewEffortProxy: number
}

export interface AgentEmployeeEvolutionLedgerResult {
  windowDays: number
  generatedAt: number
  entries: AgentEmployeeEvolutionLedgerEntryResult[]
  totals: { approved: number; rejected: number; pending: number; rollbacks: number; sanitizedSamples: number; evaluationCostUsd: number }
  disclaimer: string
}

export interface EvolutionPackageValidationResult {
  ok: boolean
  reason?: string
  summary?: { agentCount: number; versionCount: number; candidateCount: number; sanitizedSampleCount: number; note: string }
}

export interface AgentEmployeeCapabilityRollbackPreviewResult {
  versionId: string
  scope: 'role' | 'workspace'
  workspaceId?: string
  targetVersionId?: string
  targetVersionNumber?: number
  targetIsBaseline: boolean
  activeExecutionCount: number
  dependentWorkspaceVersionCount: number
  historicalExecutionsUnaffected: true
  note: string
}

export interface AgentEmployeeCapabilityAlertResult {
  code: 'consecutive_failures' | 'rework_spike' | 'stale_observation'
  severity: 'info' | 'warning'
  versionId: string
  message: string
  evidence: string
}

export interface SampleSensitiveFindingResult {
  kind: 'absolute_path' | 'credential' | 'email' | 'url_with_credentials' | 'session_reference' | 'long_token'
  message: string
  excerpt: string
}

export interface BenchmarkVersionHistoryEntryResult {
  snapshot: { version: number; rubricVersion: number; cases: string[]; heldOutCases: string[]; targetType: string; targetAgentId: string; targetScope?: string; targetWorkspaceId?: string }
  recordedAt: number
  driftReasons: string[]
  latestScore?: number | null
}

export interface EmployeeCapabilityScanScheduleResult {
  enabled: boolean
  intervalHours: number
  lastRunAt?: number
  updatedAt: number
}

export interface RunAgentEmployeeCapabilityEvaluationInput {
  agentId: string
  scope: 'role' | 'workspace'
  workspaceId?: string
  channelId: string
  modelId: string
  judgeChannelId?: string
  judgeModelId?: string
  maxRounds?: number
}

export interface AgentEmployeeCapabilityEvaluationResult {
  benchmarkId: string
  baselineScore: number
  finalScore: number
  heldOutBaselineScore: number | null
  heldOutFinalScore: number | null
  judgeIndependent: boolean
  judgeKind: 'rule' | 'llm' | 'injected'
  acceptedRounds: number
  trainingSampleCount: number
  heldOutSampleCount: number
  approvalId?: string
  status: 'candidate_created' | 'no_accepted_candidate' | 'judge_not_independent' | 'held_out_regression'
  message: string
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
  REJECT_CONTROLLED_ACTION: 'new-media:reject-controlled-action',
  SIMULATE_CONTROLLED_ACTION: 'new-media:simulate-controlled-action',
  EXECUTE_CONTROLLED_ACTION: 'new-media:execute-controlled-action',
  RECONCILE_CONTROLLED_EXECUTION: 'new-media:reconcile-controlled-execution',
  RETRY_CONTROLLED_EXECUTION: 'new-media:retry-controlled-execution',
  LIST_CONTROLLED_EXECUTORS: 'new-media:list-controlled-executors',
  LIST_WECHAT_PUBLISHES: 'new-media:list-wechat-publishes',
  POLL_WECHAT_PUBLISH: 'new-media:poll-wechat-publish',
  RECONCILE_WECHAT_SUBMIT: 'new-media:reconcile-wechat-submit',
  SYNC_WECHAT_USER_METRICS: 'new-media:sync-wechat-user-metrics',
  SYNC_WECHAT_ARTICLE_METRICS: 'new-media:sync-wechat-article-metrics',
  GET_WECHAT_ANALYTICS_OVERVIEW: 'new-media:get-wechat-analytics-overview',
  SYNC_WECHAT_COMMENTS: 'new-media:sync-wechat-comments',
  LIST_AUTOMATION_RULES: 'new-media:list-automation-rules',
  CREATE_AUTOMATION_RULE: 'new-media:create-automation-rule',
  SET_AUTOMATION_RULE_ENABLED: 'new-media:set-automation-rule-enabled',
  DELETE_AUTOMATION_RULE: 'new-media:delete-automation-rule',
  LIST_AUTOMATION_RUNS: 'new-media:list-automation-runs',
  TICK_AUTOMATIONS: 'new-media:tick-automations',
  LIST_WECHAT_COMMENTS: 'new-media:list-wechat-comments',
  GET_CONTROLLED_ACTION_AUDIT: 'new-media:get-controlled-action-audit',
  LIST_ACCOUNTS: 'new-media:list-accounts',
  CREATE_ACCOUNT: 'new-media:create-account',
  BEGIN_ACCOUNT_AUTHORIZATION: 'new-media:begin-account-authorization',
  VALIDATE_ACCOUNT: 'new-media:validate-account',
  DISCONNECT_ACCOUNT: 'new-media:disconnect-account',
  REMOVE_ACCOUNT: 'new-media:remove-account',
  GET_ACCOUNT_AUDIT: 'new-media:get-account-audit',
  GET_ADAPTER_INFO: 'new-media:get-adapter-info',
  GET_SCHEMA_INFO: 'new-media:get-schema-info',
  GET_ACCOUNT_CAPABILITIES: 'new-media:get-account-capabilities',
  CONNECT_WECHAT_DIRECT: 'new-media:connect-wechat-direct',
  LIST_XHS_HANDOFFS: 'new-media:list-xhs-handoffs',
  PREPARE_XHS_HANDOFF: 'new-media:prepare-xhs-handoff',
  EXPORT_XHS_HANDOFF: 'new-media:export-xhs-handoff',
  CONFIRM_XHS_PUBLISHED: 'new-media:confirm-xhs-published',
  GET_XHS_HANDOFF_AUDIT: 'new-media:get-xhs-handoff-audit',
  LIST_IMPORT_CONTRACTS: 'new-media:list-import-contracts',
  PICK_REPORT_FILE: 'new-media:pick-report-file',
  CANCEL_IMPORT_PREVIEW: 'new-media:cancel-import-preview',
  COMMIT_REPORT_IMPORT: 'new-media:commit-report-import',
  LIST_IMPORT_BATCHES: 'new-media:list-import-batches',
  LIST_IMPORTED_ROWS: 'new-media:list-imported-rows',
  GET_INSIGHT_REPORT: 'new-media:get-insight-report',
} as const

export type NewMediaPlatform = 'xiaohongshu' | 'wechat-official-account'
export type NewMediaAuthorizationMethod = 'unavailable' | 'oauth2' | 'api_key' | 'managed_browser' | 'wechat_direct'
export type NewMediaAccountStatus = 'disconnected' | 'authorization_pending' | 'connected' | 'expired' | 'revoked' | 'error'
export type NewMediaCredentialProtection = 'encrypted' | 'degraded' | 'none'

export interface NewMediaPlatformCapabilities {
  localDraft: boolean
  remoteDraft: boolean
  publish: boolean
  readEngagements: boolean
  sendReply: boolean
  readMetrics: boolean
}

export interface NewMediaAdapterInfo {
  platform: NewMediaPlatform
  displayName: string
  authorizationMethod: NewMediaAuthorizationMethod
  authorizationAvailable: boolean
  authorizationDescription: string
  requestedScopes: string[]
  capabilities: NewMediaPlatformCapabilities
}

// ===== 微信公众号 direct 账号模型 =====

export type WechatAccountType = 'subscription' | 'service' | 'test'
export type WechatVerificationStatus = 'verified' | 'unverified'

export interface WechatDirectAccountProfile {
  appId: string
  accountType: WechatAccountType
  verificationStatus: WechatVerificationStatus
  /** 平台实际返回的接口权限名；本地不推断、不补全。 */
  grantedScopes: string[]
  /** 用户是否已在微信后台配置当前出口 IP 白名单。 */
  ipWhitelistConfigured: boolean
  stableTokenExpiresAt?: number
  lastTokenRefreshedAt?: number
}

export type WechatDirectCapabilityReason =
  | 'enabled'
  | 'no_credential'
  | 'not_connected'
  | 'account_type_not_allowed'
  | 'verification_required'
  | 'scope_not_granted'
  | 'ip_whitelist_required'

export interface WechatDirectCapabilityState {
  capability: string
  label: string
  enabled: boolean
  reason: WechatDirectCapabilityReason
  explanation: string
  requiredScopes: readonly string[]
  externalSideEffect: boolean
}

// ===== 微信公众号素材 =====

export type WechatMediaType = 'image' | 'thumb'
export type WechatMediaMode = 'temporary' | 'permanent' | 'inline'
export type WechatMediaUploadStatus = 'uploaded' | 'failed'

export interface WechatMediaUploadAttempt {
  mediaId?: string
  url?: string
  uploadedAt: number
  expiresAt?: number
  status: WechatMediaUploadStatus
  /** 失败原因码（平台 errcode 或本地预检码），不含凭据。 */
  errorCode?: string
}

export interface WechatMediaAsset {
  id: string
  accountId: string
  type: WechatMediaType
  mode: WechatMediaMode
  /** 内容 SHA-256：同账号同类型同模式同内容即复用。 */
  sha256: string
  byteLength: number
  format: string
  /** 仅保存文件名，不保存本地绝对路径。 */
  sourceFileName: string
  currentMediaId?: string
  currentUrl?: string
  currentExpiresAt?: number
  /** 上传历史，最新的在前，用于追溯平台下发过的 media_id。 */
  uploads: WechatMediaUploadAttempt[]
  createdAt: number
  updatedAt: number
}

// ===== 微信公众号草稿 =====

export interface WechatDraftArticle {
  title: string
  author?: string
  digest?: string
  /** 正文 HTML。 */
  content: string
  contentSourceUrl?: string
  /** 封面素材：优先使用已上传素材的 media_id。 */
  thumbMediaId?: string
  needOpenComment?: boolean
  onlyFansCanComment?: boolean
}

export type WechatDraftSyncStatus =
  | 'local_only'
  | 'synced'
  | 'update_conflict'
  | 'delete_failed'
  | 'deleted'

export interface WechatDraftRecord {
  id: string
  accountId: string
  /** 关联的新媒体本地内容草稿；可为空表示仅在微信侧维护。 */
  localDraftId?: string
  /** 平台返回的草稿 media_id；未同步时为空。 */
  platformMediaId?: string
  articles: WechatDraftArticle[]
  /** 本地修订号，每次本地修改 +1。 */
  localRevision: number
  status: WechatDraftSyncStatus
  /** 最近一次成功同步时平台返回的更新时间，用于检测他人修改。 */
  platformSyncTime?: number
  lastSyncedAt?: number
  /** 最近一次失败的本地原因码，用于恢复而不是静默重试。 */
  lastErrorCode?: string
  createdAt: number
  updatedAt: number
}

// ===== 微信公众号发布（freepublish） =====

export type WechatPublishStatus =
  | 'submit_requested'
  | 'publishing'
  | 'published'
  | 'rejected'
  | 'failed'
  | 'deleted'
  | 'unknown'

export interface WechatPublishTransition {
  from: WechatPublishStatus | null
  to: WechatPublishStatus
  platformStatus?: number
  at: number
  note: string
}

export interface WechatPublishRecord {
  id: string
  accountId: string
  /** 本地微信草稿记录 id。 */
  draftId: string
  platformMediaId: string
  /** 平台返回的 publish_id；提交成功即保存，用于后续查询与对账。 */
  publishId?: string
  status: WechatPublishStatus
  /** 平台原始 publish_status 数值，保留以便核对映射是否准确。 */
  platformStatus?: number
  articleId?: string
  articleUrl?: string
  failIndices?: number[]
  submittedAt: number
  lastPolledAt?: number
  publishedAt?: number
  /** 提交结果未知时禁止再次提交，必须先对账。 */
  submitOutcomeUnknown?: boolean
  failureCode?: string
  transitions: WechatPublishTransition[]
  createdAt: number
  updatedAt: number
}

// ===== 微信分析数据（本地快照口径） =====

export type WechatAnalyticsSource = 'usersummary' | 'usercumulate' | 'articletotal' | 'articlesummary'

export interface WechatUserMetricRecord {
  id: string
  accountId: string
  source: 'usersummary' | 'usercumulate'
  date: string
  metrics: Record<string, number>
  capturedAt: number
  updatedAt: number
}

export interface WechatArticleMetricRecord {
  id: string
  accountId: string
  source: 'articletotal' | 'articlesummary'
  date: string
  msgid: string
  title: string
  metrics: Record<string, number>
  capturedAt: number
  updatedAt: number
}

export interface WechatAnalyticsSyncResult {
  source: WechatAnalyticsSource
  requestedRange: { beginDate: string; endDate: string }
  effectiveRange: { beginDate: string; endDate: string }
  rows: number
  latencyDays: number
}

export interface WechatAnalyticsOverview {
  accountId: string
  sources: Array<{
    source: WechatAnalyticsSource
    label: string
    latestDate?: string
    lagDays?: number
    rowCount: number
    definition: string
  }>
  limits: { verifiedAt: string; source: string }
}

// ===== 商业能力授权证明（P4-01） =====

/** 商业授权证明类型：平台 scope 书面授权 / 白名单 / 数据供应商许可。 */
export type NewMediaCommercialProofType = 'scope_grant' | 'whitelist' | 'vendor_license'

export interface NewMediaCommercialProof {
  id: string
  type: NewMediaCommercialProofType
  /** 证明指向的商业能力，例如 pugongying-data、juguang-ads、licensed-listening。 */
  capability: string
  /** 平台或供应商出具的可核查凭据（合同号、后台截图编号、工单号等）。 */
  reference: string
  grantedAt: number
  expiresAt?: number
  /** 由谁核验：必须是显式的人或流程，不接受「默认有权限」。 */
  verifiedBy: string
  note?: string
}

/** 商业能力门控结果：无证明、过期或未核验都不得启用。 */
export interface NewMediaCommercialGateState {
  capability: string
  enabled: boolean
  reason: 'enabled' | 'no_proof' | 'proof_expired' | 'proof_not_verified'
  explanation: string
  proofId?: string
  expiresAt?: number
}

// ===== 素材来源与 AIGC 标识链（P4-09） =====

export type NewMediaAssetSourceKind = 'uploaded' | 'generated' | 'licensed' | 'unknown'

export interface NewMediaAssetProvenance {
  id: string
  /** 素材标识：可指向微信素材、本地附件或交付包内文件。 */
  assetKey: string
  accountId: string
  source: {
    kind: NewMediaAssetSourceKind
    /** 原始来源（URL 或文件名），不保存本地绝对路径。 */
    origin?: string
    uploadedBy?: string
    /** 生成素材时记录模型与提示词引用。 */
    generatedByModel?: string
    promptRef?: string
  }
  license: {
    status: 'granted' | 'missing' | 'unknown'
    licenseRef?: string
    grantedBy?: string
    expiresAt?: number
  }
  /** AIGC 标识：平台要求标识时，未标识的素材不得外发。 */
  aigc: {
    isAigc: boolean
    model?: string
    labelApplied?: boolean
  }
  createdAt: number
  updatedAt: number
}

export type NewMediaAssetPublishBlockReason =
  | 'no_provenance'
  | 'license_missing'
  | 'license_unknown'
  | 'license_expired'
  | 'aigc_unlabeled'

export interface NewMediaAssetPublishCheck {
  assetKey: string
  publishable: boolean
  reason?: NewMediaAssetPublishBlockReason
  explanation: string
}

// ===== 能力开关与灰度（P4-13） =====

/** 灰度阶段：off 全关；allowlist 仅名单内账号；all 全量。 */
export type NewMediaRolloutStage = 'off' | 'allowlist' | 'all'

export interface NewMediaCapabilityFlag {
  id: string
  capability: string
  /** 作用域：platform 全平台；accountId 限定单个账号（本地形态下即租户）。 */
  scope: { platform?: NewMediaPlatform; accountId?: string }
  stage: NewMediaRolloutStage
  /** allowlist 阶段的账号名单。 */
  allowlist: string[]
  note?: string
  updatedBy: string
  updatedAt: number
}

export interface NewMediaCapabilityFlagDecision {
  capability: string
  platform?: NewMediaPlatform
  accountId?: string
  active: boolean
  /** 命中的开关；无覆盖时为 enabled 默认。 */
  matchedFlagId?: string
  reason: string
}

// ===== 合规守卫（P4-08） =====

export type NewMediaComplianceCategory = 'advertising-law' | 'platform-rule' | 'copyright' | 'crisis'
export type NewMediaComplianceSeverity = 'suggest' | 'high-risk'

export interface NewMediaComplianceRule {
  id: string
  category: NewMediaComplianceCategory
  severity: NewMediaComplianceSeverity
  /** 匹配方式：正则来源串（大小写不敏感）。 */
  pattern: string
  label: string
  message: string
  suggestion: string
}

export interface NewMediaComplianceFinding {
  ruleId: string
  category: NewMediaComplianceCategory
  severity: NewMediaComplianceSeverity
  label: string
  matchedText: string
  message: string
  suggestion: string
}

export interface NewMediaComplianceReview {
  platform: NewMediaPlatform
  findings: NewMediaComplianceFinding[]
  /** 高风险发现存在时为 true：升级人工，本地不做法律判定。 */
  requiresHumanReview: boolean
  reviewedAt: number
  disclaimer: string
}

// ===== 自动化排程（P4-10） =====

export type NewMediaAutomationCadence =
  | { type: 'daily'; timeOfDay: string }
  | { type: 'intervalHours'; hours: number }

export interface NewMediaAutomationRule {
  id: string
  accountId: string
  platform: NewMediaPlatform
  kind: 'publish' | 'send-reply'
  /** 目标内容（如微信草稿记录 id）。 */
  targetId: string
  /** 摘要模板，支持 {{date}} 占位。 */
  summaryTemplate: string
  cadence: NewMediaAutomationCadence
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  consecutiveFailures: number
  autoDisabledAt?: number
  autoDisabledReason?: string
  createdAt: number
  updatedAt: number
}

export type NewMediaAutomationRunOutcome = 'created' | 'skipped' | 'failed'

export interface NewMediaAutomationRun {
  id: string
  ruleId: string
  /** 本次触发对应的计划时间，用于幂等去重。 */
  occurrenceAt: number
  outcome: NewMediaAutomationRunOutcome
  actionId?: string
  detail: string
  errorCode?: string
  ranAt: number
}

export interface WechatCommentRecord {
  id: string
  accountId: string
  /** 群发/图文消息 id（平台要求的数据标识）。 */
  msgDataId: string
  /** 多图文消息中的第几篇，从 0 开始。 */
  articleIndex: number
  /** 平台侧留言唯一标识，来源追溯的关键字段。 */
  userCommentId: string
  content: string
  createTime?: number
  /** 平台返回的作者回复（只读展示，不在本地发起回复）。 */
  replies: Array<{ content: string; createTime?: number }>
  syncedAt: number
}

export interface WechatCommentSyncResult {
  msgDataId: string
  articleIndex: number
  fetched: number
  stored: number
  total: number
  pages: number
}

export interface NewMediaConnectedAccount {
  id: string
  platform: NewMediaPlatform
  displayName: string
  externalAccountId?: string
  status: NewMediaAccountStatus
  authorizationMethod: NewMediaAuthorizationMethod
  grantedScopes: string[]
  capabilities: NewMediaPlatformCapabilities
  credentialRef?: string
  credentialProtection: NewMediaCredentialProtection
  /** 微信公众号 direct 账号档案；其它平台或未配置时为空。 */
  wechatDirect?: WechatDirectAccountProfile
  /** 最近一次能力协商结果；UI 只能展示，不得自行推断能力。 */
  capabilityStates?: WechatDirectCapabilityState[]
  authorizedAt?: number
  expiresAt?: number
  lastValidatedAt?: number
  errorCode?: string
  createdAt: number
  updatedAt: number
}

export interface NewMediaAuthorizationStart {
  accountId: string
  status: NewMediaAccountStatus
  method: NewMediaAuthorizationMethod
  available: boolean
  description: string
}

export type NewMediaAccountAuditEvent = 'account_created' | 'authorization_started' | 'connected' | 'validation_failed' | 'disconnected' | 'revoked' | 'removed'
export interface NewMediaAccountAuditEntry {
  id: string
  accountId: string
  event: NewMediaAccountAuditEvent
  actor: string
  detail: string
  createdAt: number
}

export interface NewMediaContentDraft {
  id: string
  sourceText: string
  platformCopies: Partial<Record<NewMediaPlatform, { title: string; body: string; hashtags: string[] }>>
  createdAt: number
}

export type XiaohongshuHandoffStatus = 'draft_ready' | 'handed_off' | 'user_confirmed_published'
export interface XiaohongshuHandoff {
  id: string
  draftId: string
  status: XiaohongshuHandoffStatus
  packageVersion: 1
  packageFileName: string
  packageSha256?: string
  warnings: string[]
  handedOffAt?: number
  handedOffBy?: string
  confirmedAt?: number
  confirmedBy?: string
  createdAt: number
  updatedAt: number
}
export type XiaohongshuHandoffAuditEvent = 'prepared' | 'exported' | 'user_confirmed_published'
export interface XiaohongshuHandoffAuditEntry {
  id: string
  handoffId: string
  event: XiaohongshuHandoffAuditEvent
  actor: string
  detail: string
  createdAt: number
}
export interface XiaohongshuHandoffExportResult {
  canceled: boolean
  fileName?: string
  sha256?: string
}

// ===== 小红书报表导入 =====

export type NewMediaImportSourceKind =
  | 'xiaohongshu-professional'
  | 'xiaohongshu-pugongying'
  | 'xiaohongshu-juguang'

export type NewMediaImportMetricKind = 'date' | 'text' | 'count' | 'currency' | 'ratio'

export interface NewMediaImportColumn {
  field: string
  label: string
  kind: NewMediaImportMetricKind
  definition: string
  required: boolean
  aliases: readonly string[]
}

export interface NewMediaImportContract {
  sourceKind: NewMediaImportSourceKind
  label: string
  origin: string
  commercial: boolean
  requiresCommercialAuthorization: boolean
  boundary: string
  columns: readonly NewMediaImportColumn[]
}

export interface NewMediaImportInvalidRow {
  rowNumber: number
  reason: string
}

export interface NewMediaImportPreviewRow {
  rowNumber: number
  date: string
  contentTitle?: string
  metrics: Record<string, number>
}

export interface NewMediaImportPreview {
  sourceKind: NewMediaImportSourceKind
  fileName: string
  fileSha256: string
  sheetName?: string
  headers: string[]
  mapping: Record<string, number>
  matchedFields: string[]
  missingRequired: string[]
  unmappedHeaders: string[]
  totalRows: number
  validRows: number
  invalidRows: NewMediaImportInvalidRow[]
  existingBatchId?: string
  previewRows: NewMediaImportPreviewRow[]
  boundary: string
  commercial: boolean
  /** 本次预览的短期凭据；提交时用它引用主进程已读取的文件，渲染进程无需接触文件内容。 */
  pendingToken: string
}

export type NewMediaImportPickResult =
  | { canceled: true }
  | { canceled: false; preview: NewMediaImportPreview }

export interface NewMediaReportImportBatch {
  id: string
  sourceKind: NewMediaImportSourceKind
  platform: NewMediaPlatform
  accountId: string
  fileName: string
  fileSha256: string
  totalRows: number
  importedRows: number
  skippedDuplicateRows: number
  invalidRows: NewMediaImportInvalidRow[]
  mapping: Record<string, number>
  commercial: boolean
  importedAt: number
  importedBy: string
  duplicateOfBatchId?: string
}

export interface NewMediaImportedReportRow {
  id: string
  batchId: string
  sourceKind: NewMediaImportSourceKind
  commercial: boolean
  platform: NewMediaPlatform
  accountId: string
  capturedAt: number
  contentId?: string
  contentTitle?: string
  brand?: string
  planName?: string
  metrics: Record<string, number>
  rowNumber: number
  rowHash: string
  createdAt: number
}

export interface NewMediaInsightSourceSummary {
  sourceKind: NewMediaImportSourceKind
  label: string
  commercial: boolean
  rowCount: number
  batchCount: number
  lastCapturedAt?: number
  boundary: string
}

export interface NewMediaInsightSection {
  scope: 'account' | 'commercial'
  totals: Record<string, number>
  measuredMetrics: string[]
  sources: NewMediaInsightSourceSummary[]
  coveredDays: string[]
  missingDays: string[]
  lastCapturedAt?: number
  freshnessLagDays?: number
}

export interface NewMediaInsightReport {
  periodStart: number
  periodEnd: number
  generatedAt: number
  account: NewMediaInsightSection
  commercial: NewMediaInsightSection
  manualSnapshotCount: number
  disclaimers: string[]
}

export interface NewMediaSchemaInfo {
  version: number
  currentVersion: number
  rollbackAvailable: boolean
  appliedMigrations: Array<{ version: number; direction: string; description: string; appliedAt: number }>
  registeredKinds: Array<{ kind: string; domain: string; description: string }>
  unknownKinds: string[]
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

export type NewMediaControlledActionStatus =
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'simulated'

/** 执行失败的结果分类：unknown 表示请求可能已被平台接受，重试前必须对账。 */
export type NewMediaExecutionOutcome = 'not_started' | 'unknown' | 'confirmed_failure'

export interface NewMediaExecutionReceipt {
  platform: NewMediaPlatform
  externalId?: string
  platformStatus?: string
  summary: string
  receivedAt: number
  details?: Record<string, string | number | boolean>
}

export interface NewMediaControlledAction {
  id: string
  kind: 'publish' | 'send-reply'
  platform: NewMediaPlatform
  targetId: string
  /** 目标账号；真实执行器必须据此解析凭据，缺失时拒绝执行。 */
  accountId?: string
  summary: string
  status: NewMediaControlledActionStatus
  requestedAt: number
  approvedAt?: number
  approvedBy?: string
  /** 审批时冻结的动作载荷摘要；执行前必须重验，旧记录缺失时不得产生新副作用。 */
  approvalPayloadHash?: string
  /** 审批绑定的请求版本；当前新请求从 1 开始。 */
  approvalRevision?: number
  /** 动作请求版本。修改目标、账号或摘要时必须递增并重新审批。 */
  revision?: number
  executedAt?: number
  /** 仅本地模拟路径产生；与真实执行回执分开保存，避免混淆。 */
  simulationReceipt?: string
  /** 本次执行使用的路径，缺省表示尚未执行。 */
  executionMode?: 'simulated' | 'live'
  /** 当前（或最近一次）执行尝试标识，用于与平台回执对账。 */
  executionAttemptId?: string
  executionStartedAt?: number
  receipt?: NewMediaExecutionReceipt
  failureCode?: string
  failureOutcome?: NewMediaExecutionOutcome
  /** true 表示失败结果不确定，必须人工对账后才允许重试。 */
  retryRequiresReconciliation?: boolean
  reconciledAt?: number
  reconciledBy?: string
  attempts: number
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
