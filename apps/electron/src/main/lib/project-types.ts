/**
 * 项目管理类型定义
 *
 * 抽离为独立文件，避免 project-service.ts / local-project-store.ts / nocobase-project-service.ts 之间循环引用。
 */

export type ProjectStatus = 'planning' | 'active' | 'completed' | 'cancelled'

export interface Project {
  id: string
  title: string
  description: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
}

/**
 * 任务状态 ID：预置五态沿用旧字符串作固定 id（历史数据零迁移），
 * 自定义状态为 task_statuses 表新建的 id。
 */
export type LegacyTaskStatus = 'draft' | 'pending' | 'in_progress' | 'paused' | 'completed'
export type TaskStatus = LegacyTaskStatus | (string & {})
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type ExecutableWorkItemType = 'task' | 'subTask'

/**
 * 状态语义组（借鉴 Plane StateGroup）。
 * 完成判断、WIP、燃尽等跨状态逻辑只认组，不认具体状态 id；
 * 具体状态是每项目独立的数据行，支持自定义。
 */
export type TaskStateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' | 'triage'

/** 项目任务状态定义（task_statuses 表行） */
export interface TaskStatusDef {
  id: string
  projectId: string
  name: string
  stateGroup: TaskStateGroup
  /** 展示顺序（看板列序，小者在前） */
  position: number
  /** 列颜色（可空，前端按语义组给默认色） */
  color?: string
  /** WIP 上限（可空 = 不限；当前仅做超限展示提醒） */
  wipLimit?: number
  /** 预置状态（不可删除，可改名/换色/调序） */
  isBuiltin: boolean
  /** 默认初始状态（任务确认后落入；外部"未完成"回退目标） */
  isDefault: boolean
  createdAt: number
}

export interface CreateTaskStatusInput {
  name: string
  stateGroup: TaskStateGroup
  color?: string
  wipLimit?: number
  /** 插入到某状态之后；缺省追加到末尾 */
  afterStatusId?: string
}

export type UpdateTaskStatusInput = Partial<Pick<TaskStatusDef, 'name' | 'stateGroup' | 'color' | 'wipLimit'>>

export interface TaskAssignee {
  userId: string
  displayName: string
}

/** Task 与执行型 subTask 的共同执行契约。 */
export interface ExecutableWorkItem {
  entityType: ExecutableWorkItemType
  id: string
  projectId: string
  title: string
  status: TaskStatus
  assignee?: TaskAssignee
  startDate?: number
  dueDate?: number
  completedAt?: number
  /** 完成说明；Task 与执行型 subTask 保持同一执行闭环。 */
  completionNotes?: string
  externalSync?: Task['externalSync']
  createdAt: number
  updatedAt: number
}

/** 挂在 Task 下的独立执行单元，不等同于 WBS 的 Task.parentId。 */
export interface SubTask extends ExecutableWorkItem {
  entityType: 'subTask'
  taskId: string
}

export interface Task {
  id: string
  projectId: string
  /** 父任务 ID，存在时该任务为子任务 */
  parentId?: string
  title: string
  description: string
  assignee?: TaskAssignee
  /** 负责人对应的统一成员目录 ID（身份统一后为权威匹配键） */
  assigneeMemberId?: string
  startDate?: number
  priority: TaskPriority
  status: TaskStatus
  dueDate?: number
  completedAt?: number
  externalSync?: {
    feishu?: { taskId: string; status: string; syncedAt: number }
    dingtalk?: { taskId: string; status: string; syncedAt: number; unionId?: string }
  }
  /** 风险等级：low / medium / high / critical */
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  /** 完成纪要 */
  completionNotes?: string
  /** by-task 申请的额外权限（P1）：'bash' | 'write' | 'web' | 'mcp:<name>'；获批后执行用对应权限模式 */
  permissionRequests?: string[]
  /** 发起/创建者（PH2-⑤） */
  createdByUserId?: string
  /** 发起/创建者对应的统一成员目录 ID */
  createdByMemberId?: string
  /** AI 员工执行目标工作区（PH2-③：指定执行落在哪个工作区，缺省用员工/全局） */
  workspaceId?: string
  /** AI 员工执行 token 配额（可选）：累计消耗超限即中止执行，任务回退 paused 待人工处理 */
  tokenBudget?: number
  /** 看板/列表展示排序键（升序；拖拽中点法维护，新建任务为创建时刻的负值=最新在前） */
  sortOrder: number
  /** 子任务（任务拆解）。@deprecated 子任务已升级为独立 Task，请优先使用 parentId 关联 */
  subTasks?: SubTask[]
  createdAt: number
  updatedAt: number
}

export interface MeetingNote {
  id: string
  projectId: string
  title: string
  rawContent: string
  extractedTaskIds: string[]
  createdAt: number
}

export interface UserMapping {
  paaUserId: string
  displayName: string
  feishuUserId?: string
  feishuUnionId?: string
  dingtalkUserId?: string
  dingTalkUnionId?: string
  source: 'auto-sync' | 'manual'
  updatedAt: number
}

export interface CreateProjectInput {
  title: string
  description: string
  status?: ProjectStatus
}

export interface CreateTaskInput {
  title: string
  description: string
  assignee?: TaskAssignee
  /** 负责人对应的统一成员目录 ID（优先于自由文本 assignee） */
  assigneeMemberId?: string
  priority?: TaskPriority
  startDate?: number
  dueDate?: number
  /** 父任务 ID，存在时创建为子任务 */
  parentId?: string
  /** by-task 权限申请（P1） */
  permissionRequests?: string[]
  /** 发起/创建者（PH2-⑤：“我指派的”视图用） */
  createdByUserId?: string
  /** 发起/创建者对应的统一成员目录 ID */
  createdByMemberId?: string
  /** AI 员工执行目标工作区（可选；缺省用员工/全局默认） */
  workspaceId?: string
  /** AI 员工执行 token 配额（可选）：累计消耗超限即中止执行 */
  tokenBudget?: number
}

/** 创建独立执行 subTask 的输入；它通过 taskId 归属 Task，不使用 WBS parentId。 */
export interface CreateExecutionSubTaskInput {
  title: string
  assignee?: TaskAssignee
  startDate?: number
  dueDate?: number
}

export interface ListTasksFilter {
  status?: TaskStatus
  /** 按语义组过滤（跨自定义状态筛选） */
  statusGroup?: TaskStateGroup
  assigneeUserId?: string
  /** 是否包含子任务，默认 false */
  includeSubTasks?: boolean
  /** 是否包含草稿任务，默认 false */
  includeDrafts?: boolean
}

/** 拖拽排序输入：目标位置由邻居表达（after=落点上方邻居、before=落点下方邻居；都不给=追加到列尾）。两个邻居分别定位，任一命中即采用；跨列时给 newStatusId */
export interface ReorderTaskInput {
  /** 放置到该任务之后（该任务成为上方邻居；列首拖拽时缺失） */
  afterTaskId?: string
  /** 放置到该任务之前（该任务成为下方邻居；列尾拖拽时缺失） */
  beforeTaskId?: string
  /** 同时改状态（拖入另一列）；缺省保持原状态 */
  newStatusId?: string
}

/** 看板列：一个状态 + 该状态下按展示顺序排列的任务 */
export interface KanbanColumn {
  status: TaskStatusDef
  tasks: Task[]
}

export interface KanbanBoard {
  columns: KanbanColumn[]
}

/** 排序结果：被移动任务 + 触发重编号时一并改写的任务 */
export interface ReorderTaskResult {
  task: Task
  /** 整列重编号时一并改写的其他任务（按新顺序） */
  rewrittenTasks: Task[]
}

export interface ProjectProgress {
  total: number
  completed: number
  percentage: number
}

export interface SaveUserMappingInput {
  paaUserId: string
  displayName: string
  feishuUserId?: string
  feishuUnionId?: string
  dingtalkUserId?: string
  dingTalkUnionId?: string
}

export interface ImportAndExtractResult {
  note: MeetingNote
  drafts: Task[]
}

/** 外部同步失败后可人工重试的 outbox 事件。 */
export interface TodoRetryEvent {
  id: string
  projectId?: string
  entityType: ExecutableWorkItemType
  entityId: string
  eventType: 'dingtalk.create_todo' | 'dingtalk.update_todo_status' | 'feishu.create_todo' | 'feishu.update_todo_status'
  retryCount: number
  status: 'pending' | 'processing' | 'failed' | 'completed'
  errorMessage?: string
  createdAt: number
}

export type TaskDependencyType = 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish'

/** 当前任务必须等待 dependsOnTaskId 对应任务满足依赖条件后才可推进。 */
export interface TaskDependency {
  id: string
  taskId: string
  dependsOnTaskId: string
  type: TaskDependencyType
  createdAt: number
}

/** 用于列表、看板与甘特的可解释阻塞信息。 */
export interface TaskBlocker {
  taskId: string
  dependsOnTaskId: string
  dependsOnTitle: string
  type: TaskDependencyType
  reason: string
}

/** 跨项目“我的工作”返回的可执行工作项，保留所属项目与父 Task 上下文。 */
export interface MyWorkItem extends ExecutableWorkItem {
  projectTitle: string
  parentTaskTitle?: string
  isOverdue: boolean
  /** 负责人对应的统一成员目录 ID（列表按 member_id 过滤用） */
  assigneeMemberId?: string
  /** 发起/创建者对应的统一成员目录 ID */
  createdByMemberId?: string
}

export type ProjectAlertType = 'overdue' | 'blocked' | 'high_risk'
export interface ProjectAlert {
  id: string
  projectId: string
  type: ProjectAlertType
  severity: 'warning' | 'critical'
  entityType: ExecutableWorkItemType
  entityId: string
  title: string
  description: string
  assignee?: TaskAssignee
  createdAt: number
}

export interface ProjectActivity {
  id: string
  projectId: string
  entityType: ExecutableWorkItemType
  entityId: string
  action: string
  summary: string
  payload?: Record<string, unknown>
  actor?: string
  createdAt: number
}

export interface ProjectTemplate {
  id: string
  name: string
  description: string
  taskCount: number
  createdAt: number
}

/** 核心 task 的简要回执：发 brief 给负责人，同学在钉钉填写回执。 */
export interface BriefReceipt {
  id: string
  taskId: string
  projectId: string
  /** 负责人钉钉 unionId */
  unionId: string
  /** 发送给同学的简要说明 */
  brief: string
  /** pending=待回执 / responded=已回执 / skipped=跳过 */
  status: 'pending' | 'responded' | 'skipped'
  /** 同学填写的回执内容 */
  content?: string
  /** 回执表单 URL（含 receipt id） */
  formUrl?: string
  createdAt: number
  respondedAt?: number
}

// ============================================
// AI 员工（Agent Employee）— P0
// ============================================

/** AI 员工执行运行时 */
export type AgentEmployeeRuntime = 'proma' | 'ai-sdk' | 'pi' | 'claude'

/** AI 员工档案 */
export interface AgentEmployee {
  id: string
  name: string
  role: string
  avatar?: string
  description: string
  runtime: AgentEmployeeRuntime
  channelId: string
  modelId?: string
  /** 兼容旧档案的首选工作区 ID；缺省时使用当前全局工作区。 */
  workspaceId?: string
  /** AI 员工作为角色可服务的工作区集合；执行任务须从中明确选择。 */
  workspaceIds?: string[]
  /** 绑定的 Workflow SOP ID（P3）；绑定后任务改用 Workflow 执行（需已发布） */
  executionProfile?: 'general' | 'development'
  permissionMode?: 'safe' | 'auto'
  workflowId?: string
  /** 自定义角色 system prompt */
  systemPrompt?: string
  /** 可用 Skill slug 列表 */
  skills?: string[]
  enabled: boolean
  totalTasks: number
  completedTasks: number
  avgDurationMs?: number
  failureCount: number
  createdAt: number
  updatedAt: number
}

export interface CreateAgentEmployeeInput {
  name: string
  role: string
  avatar?: string
  description: string
  runtime?: AgentEmployeeRuntime
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceIds?: string[]
  executionProfile?: 'general' | 'development'
  permissionMode?: 'safe' | 'auto'
  workflowId?: string
  systemPrompt?: string
  skills?: string[]
}

export type UpdateAgentEmployeeInput = Partial<Omit<AgentEmployee, 'id' | 'createdAt' | 'totalTasks' | 'completedTasks' | 'avgDurationMs' | 'failureCount'>>

/** AI 员工执行状态 */
export type AgentExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'

/** AI 员工执行记录 */
export interface AgentExecution {
  id: string
  projectId: string
  entityType: 'task' | 'subTask'
  entityId: string
  agentId: string
  sessionId: string
  /** 执行器类型：headless（默认）/ workflow（绑定 SOP，sessionId 存 workflow:<runId>） */
  executor?: 'headless' | 'workflow'
  status: AgentExecutionStatus
  prompt: string
  resultSummary?: string
  outputFiles?: string[]
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  error?: string
  /** by-task 申请的权限（P1 使用，P0 预留） */
  requestedPermissions?: string[]
  lastHeartbeatAt?: number
  /** 派发时冻结的角色/工作区能力版本，后续编辑不会改写历史执行。 */
  capabilityVersionIds?: string[]
  capabilityContentHash?: string
  startedAt: number
  completedAt?: number
}

export type AgentEmployeeCapabilityScope = 'role' | 'workspace'
export type AgentEmployeeCapabilityStatus = 'active' | 'candidate' | 'superseded' | 'rolled_back'
export type AgentEmployeeLearningOutcome = 'accepted' | 'changes_requested' | 'failed' | 'cancelled' | 'manual_excluded'

export interface AgentEmployeeCapabilityVersion {
  id: string
  agentId: string
  parentVersionId?: string
  versionNumber: number
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  content: string
  contentHash: string
  status: AgentEmployeeCapabilityStatus
  source: 'manual' | 'evolution'
  createdAt: number
  activatedAt?: number
  retiredAt?: number
}

export interface AgentEmployeeCapabilityObservation {
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

export interface AgentEmployeeCapabilityHealth {
  versionId: string
  /** 观察时间窗（天）。 */
  windowDays: number
  executionCount: number
  /** 返工或未通过的样本占已判定样本的比例；样本不足时为 null。 */
  reworkRate: number | null
  failureRate: number | null
  cancellationRate: number | null
  /** 已判定样本量（排除取消与待审核）；用于判断结论可信度。 */
  decidedSampleCount: number
  /** 样本量是否足以支撑趋势结论。 */
  sampleSufficient: boolean
  lastExecutedAt?: number
  /** 同 scope 内的对比对象（父版本或基线）；无则缺省。 */
  comparisonVersionId?: string
  /** 当前版本与对比对象的返工率差值（百分点）；样本不足时为 null。 */
  reworkRateDelta?: number | null
  /** 当前版本与对比对象的失败率差值（百分点）；样本不足时为 null。 */
  failureRateDelta?: number | null
  /** 对比是否具备可比样本量；false 时不应据此下结论。 */
  comparisonComparable: boolean
}

export interface AgentEmployeeCapabilityRollbackPreview {
  versionId: string
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  targetVersionId?: string
  targetVersionNumber?: number
  targetIsBaseline: boolean
  activeExecutionCount: number
  dependentWorkspaceVersionCount: number
  historicalExecutionsUnaffected: true
  note: string
}

export interface AgentEmployeeCapabilityRollbackAudit {
  id: string
  agentId: string
  scope: AgentEmployeeCapabilityScope
  workspaceId?: string
  fromVersionId: string
  toVersionId?: string
  reason: string
  actorId: string
  createdAt: number
}

export interface AgentEmployeeLearningSample {
  id: string
  agentId: string
  executionId: string
  projectId: string
  taskId: string
  capabilityVersionIds: string[]
  outcome: AgentEmployeeLearningOutcome
  evidenceSummary: string
  privacyStatus: 'pending' | 'sanitized' | 'excluded'
  createdAt: number
  labeledAt?: number
}

export interface CreateAgentExecutionInput {
  id: string
  projectId: string
  entityType: 'task' | 'subTask'
  entityId: string
  agentId: string
  sessionId: string
  executor?: 'headless' | 'workflow'
  prompt: string
  status?: AgentExecutionStatus
  requestedPermissions?: string[]
  capabilityVersionIds?: string[]
  capabilityContentHash?: string
  startedAt?: number
}

// ===== 成员（Member）档案 =====

/** 成员类型：真人 / AI 员工 / 外部 bot（为 PH1-B 成员统一预留） */
export type MemberKind = 'human' | 'agent' | 'bot'

/** 成员来源 */
export type MemberSource = 'sync' | 'manual'

/** 团队成员档案 — 从飞书/钉钉回拉 + 双向映射后的稳定成员身份真源 */
export interface Member {
  /** 稳定成员 ID（UUID） */
  memberId: string
  kind: MemberKind
  displayName: string
  /** 小写规范化名，用于匹配 */
  plainName?: string
  /** 飞书 open_id */
  feishuUserId?: string
  /** 飞书 union_id（跨平台对齐依据之一） */
  feishuUnionId?: string
  /** 钉钉 userid */
  dingtalkUserId?: string
  /** 钉钉 unionid */
  dingtalkUnionId?: string
  department?: string
  source: MemberSource
  active: boolean
  lastSyncedAt?: number
  createdAt: number
}

/** 新建成员输入（memberId 省略时自动生成） */
export interface CreateMemberInput {
  memberId?: string
  kind?: MemberKind
  displayName: string
  feishuUserId?: string
  feishuUnionId?: string
  dingtalkUserId?: string
  dingtalkUnionId?: string
  department?: string
  source?: MemberSource
}

/** 更新成员输入 */
export type UpdateMemberInput = Partial<
  Pick<Member, 'displayName' | 'feishuUserId' | 'feishuUnionId' | 'dingtalkUserId' | 'dingtalkUnionId' | 'department' | 'kind' | 'source' | 'active'>
>

/** 成员查询过滤 */
export interface ListMembersFilter {
  kind?: MemberKind
  activeOnly?: boolean
  q?: string
}
