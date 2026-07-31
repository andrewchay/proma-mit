/**
 * PAA Workflow Mode 领域模型。
 *
 * 设计约束：
 * - Definition 是可编辑、可发布和可迁移的流程定义，不记录运行时状态；
 * - Run 是一次不可变的执行快照，持有节点状态、审批和事件；
 * - 画布布局只服务编辑体验，不参与执行语义。
 */

/** 当前 Workflow 文件格式标识。 */
export const WORKFLOW_FORMAT = 'paa.workflow' as const

/** 当前领域模型格式版本。后续文件迁移以该字段为入口。 */
export const WORKFLOW_FORMAT_VERSION = '1.0' as const

/** 画布可配置的工作流节点种类。 */
export const WORKFLOW_NODE_KINDS = [
  'start',
  'end',
  'agent',
  'tool',
  'skill',
  'transform',
  'condition',
  'approval',
] as const

export type WorkflowNodeKind = typeof WORKFLOW_NODE_KINDS[number]

/** Definition 的生命周期；只有 published 版本可以创建 Run。 */
export type WorkflowDefinitionStatus = 'draft' | 'published' | 'archived'

/** 单个节点在某次 Run 中的状态。 */
export type WorkflowNodeRunStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  | 'blocked'

/** 一次 Workflow Run 的整体状态。 */
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'

/** 节点失败后的处理策略。 */
export type WorkflowFailureStrategy = 'fail' | 'continue' | 'route_to_error'

/** 工作流级别触发来源。 */
export type WorkflowTriggerKind = 'manual' | 'schedule' | 'event'

/** 定时触发配置；channel 只引用已有渠道，绝不包含密钥。 */
export interface WorkflowScheduleTriggerConfig {
  enabled?: boolean
  mode: 'interval' | 'daily' | 'weekly' | 'monthly'
  interval?: number
  intervalUnit?: 'minutes' | 'hours'
  time?: string
  dayOfWeek?: number
  dayOfMonth?: number
  channelId: string
  modelId?: string
  input?: Record<string, unknown>
  /** 默认 forbid，避免审批/长任务未结束时重复启动相同流程。 */
  concurrencyPolicy?: 'forbid' | 'allow'
}

/** 命名事件触发配置。外部系统只传事件名和 payload，渠道凭证仍由本地配置保管。 */
export interface WorkflowEventTriggerConfig {
  eventName: string
  channelId: string
  modelId?: string
  concurrencyPolicy?: 'forbid' | 'allow'
}

/** 节点所引用的 Skill 版本。 */
export interface WorkflowSkillReference {
  slug: string
  /** 发布版本锁定的 Skill 版本；未指定表示只校验 Skill 是否存在且已启用。 */
  version?: string
}

/** 节点所引用的 MCP Server。凭证始终留在工作区配置中。 */
export interface WorkflowMcpReference {
  name: string
  /** 发布时记录配置指纹，避免配置变化后静默改变已发布流程。 */
  configFingerprint?: string
}

/** 节点可使用能力的最小权限集合。 */
export interface WorkflowCapabilityPolicy {
  skills?: WorkflowSkillReference[]
  mcpServers?: WorkflowMcpReference[]
  allowedTools?: string[]
  permissionProfileId?: string
}

/** 通用重试策略；执行器后续负责将其转换为具体调度行为。 */
export interface WorkflowRetryPolicy {
  maxAttempts: number
  backoff: 'fixed' | 'exponential'
  initialDelayMs?: number
  maxDelayMs?: number
}

/** 人工审批节点的业务配置。 */
export interface WorkflowApprovalConfig {
  assigneePolicy: 'workflow_owner' | 'named_users' | 'role'
  assigneeIds?: string[]
  roleId?: string
  /** ISO 8601 duration，例如 P2D。 */
  timeout?: string
  onTimeout: 'fail' | 'continue' | 'route_to_error'
  allowEditOutput?: boolean
}

/** 本地或企业目录同步后的 Workflow 身份主体。 */
export interface WorkflowPrincipal {
  id: string
  displayName: string
  roleIds: string[]
  enabled: boolean
}

export interface WorkflowRole {
  id: string
  name: string
  memberIds: string[]
}

export interface WorkflowIdentityDirectory {
  users: WorkflowPrincipal[]
  roles: WorkflowRole[]
}

/** Agent 节点的配置。 */
export interface WorkflowAgentNodeConfig {
  prompt: string
  modelId?: string
  outputSchema?: Record<string, unknown>
}

/** 调用确定性工具/MCP 工具的节点配置。 */
export interface WorkflowToolNodeConfig {
  toolName: string
  inputMapping?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

/** 以显式 Skill 为主要执行单元的节点配置。 */
export interface WorkflowSkillNodeConfig {
  skill: WorkflowSkillReference
  prompt: string
  outputSchema?: Record<string, unknown>
}

/** 结构化变量映射节点配置。 */
export interface WorkflowTransformNodeConfig {
  assignments: Record<string, unknown>
}

/** 条件分支节点配置。条件表达式的具体语言由 DSL 阶段固定。 */
export interface WorkflowConditionNodeConfig {
  expression: string
}

/** 节点定义。不同 kind 对应不同 config，运行时必须进行格式校验。 */
export interface WorkflowNode {
  id: string
  kind: WorkflowNodeKind
  title: string
  description?: string
  config?:
    | WorkflowAgentNodeConfig
    | WorkflowToolNodeConfig
    | WorkflowSkillNodeConfig
    | WorkflowTransformNodeConfig
    | WorkflowConditionNodeConfig
    | WorkflowApprovalConfig
  capabilityPolicy?: WorkflowCapabilityPolicy
  retry?: WorkflowRetryPolicy
  onFailure?: WorkflowFailureStrategy
}

/** 节点间的语义连线。label 用于条件节点的 true/false 或业务分支名。 */
export interface WorkflowEdge {
  id: string
  from: string
  to: string
  label?: string
}

/** 仅供画布渲染使用，不能影响执行顺序或节点配置。 */
export interface WorkflowCanvasLayout {
  nodes: Record<string, { x: number; y: number }>
  viewport?: { x: number; y: number; zoom: number }
}

/** 工作流定义的发布元数据。 */
export interface WorkflowPublication {
  version: string
  publishedAt: number
  publishedBy?: string
  changeSummary?: string
}

/** 可编辑或已发布的 Workflow Definition。 */
export interface WorkflowDefinition {
  format: typeof WORKFLOW_FORMAT
  formatVersion: string
  id: string
  workspaceId: string
  teamId?: string
  name: string
  description?: string
  status: WorkflowDefinitionStatus
  version: string
  trigger: { kind: WorkflowTriggerKind; config?: Record<string, unknown> }
  inputSchema?: Record<string, unknown>
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  layout: WorkflowCanvasLayout
  publication?: WorkflowPublication
  createdAt: number
  updatedAt: number
}

/** Run 创建时冻结的 Definition 版本与能力指纹。 */
export interface WorkflowRunSnapshot {
  definitionId: string
  definitionVersion: string
  definition: WorkflowDefinition
  /** 节点级能力快照，执行时必须以此为准而非读取当前 Definition。 */
  nodeCapabilityPolicies: Record<string, WorkflowCapabilityPolicy>
  /** 所有节点能力的汇总，仅用于展示与发布预检摘要。 */
  capabilityPolicy: WorkflowCapabilityPolicy
}

/** 内置 Workflow 权限档案。自定义档案将在企业配置层扩展。 */
export const WORKFLOW_PERMISSION_PROFILES = [
  'workflow-readonly',
  'workflow-supervised',
] as const

export type WorkflowPermissionProfileId = typeof WORKFLOW_PERMISSION_PROFILES[number]

export interface WorkflowPublishInput {
  version: string
  publishedBy?: string
  changeSummary?: string
}

/** 文件导入时的目标工作区与可选新 ID；导入始终生成 Draft。 */
export interface WorkflowImportInput {
  file: unknown
  workspaceId: string
  workflowId?: string
}

/** 可在本机团队目录中分发的无凭证模板版本。 */
export interface WorkflowTemplate {
  id: string
  teamId?: string
  name: string
  description?: string
  version: string
  definition: WorkflowDefinition
  /** 不可变发布历史；definition 始终指向当前版本以兼容旧读取方。 */
  revisions: Array<{ version: string; definition: WorkflowDefinition; publishedAt: number }>
  createdAt: number
  updatedAt: number
}

/** 某个工作区对模板的安装关系；快照只用于该副本的本地回滚。 */
export interface WorkflowTemplateInstallation {
  templateId: string
  templateVersion: string
  workflowId: string
  workspaceId: string
  history: Array<{ templateVersion: string; definition: WorkflowDefinition; recordedAt: number }>
  installedAt: number
  updatedAt: number
  pendingUpgrade?: { targetVersion: string; diff: { addedNodeIds: string[]; removedNodeIds: string[]; changedNodeIds: string[] }; requestedAt: number }
}

export interface WorkflowTemplatePublishInput {
  templateId?: string
  name: string
  description?: string
  version: string
}

/** 一次模板批量安装的逐工作区结果；失败不会影响其他工作区。 */
export interface WorkflowTemplateBatchInstallResult {
  templateId: string
  templateVersion: string
  results: Array<{ workspaceId: string; status: 'installed' | 'failed'; workflowId?: string; error?: string }>
  completedAt: number
}

/** 对话式设计器返回的说明与候选 patch；调用方必须显式应用才会变更 Draft。 */
export interface WorkflowPatchProposal {
  reply: string
  patches: unknown[]
  designerSessionId: string
}

/** 单个节点运行记录。每次重试都保留独立 attempt。 */
export interface WorkflowNodeRun {
  nodeId: string
  status: WorkflowNodeRunStatus
  attempt: number
  startedAt?: number
  finishedAt?: number
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  error?: { code: string; message: string; retryable: boolean }
  agentSessionId?: string
  /** 仅用于可能产生外部副作用的 tool 节点；不确定结果绝不自动重试。 */
  sideEffect?: {
    idempotencyKey: string
    leaseId: string
    leaseExpiresAt: number
    status: 'executing' | 'requires_intervention' | 'confirmed'
    reason?: string
  }
}

/** 审批请求与决定是 Run 的一部分，不回写 Definition。 */
export interface WorkflowApprovalRecord {
  id: string
  nodeId: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  requestedAt: number
  resolvedAt?: number
  resolvedBy?: string
  comment?: string
  editedOutput?: Record<string, unknown>
  /** 创建审批时解析并冻结的主体，避免成员变更重写历史审批权限。 */
  assigneeIds: string[]
}

/** 一次独立、可恢复的工作流执行。 */
export interface WorkflowRun {
  id: string
  workspaceId: string
  teamId?: string
  snapshot: WorkflowRunSnapshot
  status: WorkflowRunStatus
  trigger: WorkflowTriggerKind
  input: Record<string, unknown>
  nodeRuns: Record<string, WorkflowNodeRun>
  approvals: WorkflowApprovalRecord[]
  startedAt?: number
  finishedAt?: number
  createdAt: number
  updatedAt: number
}

/** Run 事件是审计追加日志，不作为 Definition 的可变状态。 */
export type WorkflowRunEventType =
  | 'run_created'
  | 'node_ready'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_skipped'
  | 'node_retry_scheduled'
  | 'approval_requested'
  | 'approval_resolved'
  | 'run_completed'
  | 'run_cancelled'
  | 'run_blocked'
  | 'side_effect_lease_acquired'
  | 'side_effect_intervention_required'
  | 'side_effect_resolved'

export interface WorkflowRunEvent {
  id: string
  runId: string
  type: WorkflowRunEventType
  occurredAt: number
  nodeId?: string
  payload?: Record<string, unknown>
}

/** Workflow Mode IPC 通道。 */
export const WORKFLOW_IPC_CHANNELS = {
  LIST_DEFINITIONS: 'workflow:list-definitions',
  GET_DEFINITION: 'workflow:get-definition',
  SAVE_DEFINITION: 'workflow:save-definition',
  EXPORT_DEFINITION: 'workflow:export-definition',
  IMPORT_DEFINITION: 'workflow:import-definition',
  LIST_TEMPLATES: 'workflow:list-templates',
  PUBLISH_TEMPLATE: 'workflow:publish-template',
  INSTALL_TEMPLATE: 'workflow:install-template',
  INSTALL_TEMPLATE_BATCH: 'workflow:install-template-batch',
  UPGRADE_TEMPLATE: 'workflow:upgrade-template',
  PREVIEW_TEMPLATE_UPGRADE: 'workflow:preview-template-upgrade',
  ROLLBACK_TEMPLATE: 'workflow:rollback-template',
  RESOLVE_SIDE_EFFECT: 'workflow:resolve-side-effect',
  EXPORT_DEFINITION_FILE: 'workflow:export-definition-file',
  IMPORT_DEFINITION_FILE: 'workflow:import-definition-file',
  PUBLISH_DEFINITION: 'workflow:publish-definition',
  CREATE_RUN: 'workflow:create-run',
  GET_RUN: 'workflow:get-run',
  LIST_RUNS: 'workflow:list-runs',
  LIST_RUN_EVENTS: 'workflow:list-run-events',
  EXECUTE_AGENT_NODE: 'workflow:execute-agent-node',
  EXECUTE_DETERMINISTIC_NODE: 'workflow:execute-deterministic-node',
  EXECUTE_RUN: 'workflow:execute-run',
  RESOLVE_APPROVAL: 'workflow:resolve-approval',
  CANCEL_RUN: 'workflow:cancel-run',
  PROPOSE_PATCHES: 'workflow:propose-patches',
  GET_IDENTITY_DIRECTORY: 'workflow:get-identity-directory',
  SAVE_IDENTITY_DIRECTORY: 'workflow:save-identity-directory',
  TRIGGER_EVENT: 'workflow:trigger-event',
} as const
