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

export type TaskStatus = 'draft' | 'pending' | 'in_progress' | 'paused' | 'completed'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'
export type ExecutableWorkItemType = 'task' | 'subTask'

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
  priority?: TaskPriority
  startDate?: number
  dueDate?: number
  /** 父任务 ID，存在时创建为子任务 */
  parentId?: string
  /** by-task 权限申请（P1） */
  permissionRequests?: string[]
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
  assigneeUserId?: string
  /** 是否包含子任务，默认 false */
  includeSubTasks?: boolean
  /** 是否包含草稿任务，默认 false */
  includeDrafts?: boolean
}

export interface KanbanBoard {
  draft: Task[]
  pending: Task[]
  in_progress: Task[]
  completed: Task[]
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
  /** 默认工作区 ID；缺省时使用当前全局工作区 */
  workspaceId?: string
  /** 绑定的 Workflow SOP ID（P3）；绑定后任务改用 Workflow 执行（需已发布） */
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
  startedAt: number
  completedAt?: number
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
  startedAt?: number
}
