import type { ProviderType } from './channel'

/** 项目 Owner 的规划元数据；不是任务、执行或授权账本。 */
export interface ProjectOwnerGoalSubject {
  projectId: string
  /** 缺省为项目目标；存在时必须是同项目的真实任务。 */
  taskId?: string
}

export interface ProjectOwnerGoalInput {
  objective: string
  constraints?: string[]
  acceptanceCriteria?: string[]
  /** 仅任务目标可选；明确允许在绑定工作区检索并向本次规划请求提供有界源码片段。 */
  codeSourceAccess?: 'none' | 'bound_workspace'
}

export interface ProjectOwnerGoalBrief extends ProjectOwnerGoalSubject {
  goalVersion: number
  objective: string
  constraints: string[]
  acceptanceCriteria: string[]
  codeSourceAccess?: 'none' | 'bound_workspace'
}

export interface ProjectOwnerGoalDraft {
  schemaVersion: 1
  revision: number
  state: 'draft'
  actor: 'local-user'
  savedAt: number
  goal: ProjectOwnerGoalBrief
}

export interface SaveProjectOwnerGoalRequest extends ProjectOwnerGoalSubject {
  /** 0 仅用于首次保存；主进程生成下一版本。 */
  expectedRevision: number
  input: ProjectOwnerGoalInput
}

export interface ProjectOwnerGoalSuccess<T> {
  ok: true
  value: T
}

export interface ProjectOwnerGoalFailure {
  ok: false
  error: {
    code: 'conflict' | 'failed'
    message: string
  }
}

/** Electron 会丢失 Error 自定义字段，失败显式编码，不依赖消息字符串判断冲突。 */
export type ProjectOwnerGoalResult<T> = ProjectOwnerGoalSuccess<T> | ProjectOwnerGoalFailure

export interface ProjectOwnerGoalApi {
  getOwnerGoalDraft: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerGoalDraft | null>>
  saveOwnerGoalDraft: (request: SaveProjectOwnerGoalRequest) => Promise<ProjectOwnerGoalResult<ProjectOwnerGoalDraft>>
}

/** 计划内步骤不是权威任务，roleKey仅为岗位能力建议。 */
export interface ProjectOwnerPlanStep {
  key: string
  title: string
  outcome: string
  acceptanceCriteria: string[]
  dependencies: string[]
  roleKey: string
  /** 模型引用的工作区代码定位证据；只指向本次冻结搜索命中的路径/行，不代表验证结论。 */
  sourceReferences?: { path: string; line: number; sha256: string }[]
}

export interface ProjectOwnerPlanProposal extends ProjectOwnerGoalSubject {
  goalVersion: number
  mode: 'proposal_only'
  summary: string
  assumptions: string[]
  risks: string[]
  steps: ProjectOwnerPlanStep[]
  deliveryChangeAssessment?: ProjectOwnerDeliveryChangeAssessment
}

/** 对旧交付的拟议差异；不是已实施变更或新授权。 */
export interface ProjectOwnerDeliveryChangeAssessment {
  summary: string
  commands: Array<{
    commandId: string
    changes: Array<{ criterion: string; disposition: 'addressed' | 'still_open' | 'not_applicable'; proposedChange: string }>
    authorizationImpact: 'unchanged' | 'additional_confirmation' | 'new_grant_required' | 'cannot_determine'
    authorizationRationale: string
  }>
}

export interface ProjectOwnerDeliveryAuthorizationContext {
  grantState: 'active' | 'paused' | 'needs_reconcile' | 'archived'
  dispatchMode: 'manual' | 'autonomous'
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
  roleBudgetCaps: Array<{ roleKey: string; maxCostMicros: number }>
}

export interface ProjectOwnerRoleAdvice {
  key: string
  name: string
  version: string
  sourceSha256: string
  rulesSha256: string
}

export interface ProjectOwnerCodeExcerpt {
  path: string
  line: number
  text: string
}

export interface ProjectOwnerCodeFileMatch {
  path: string
  sha256: string
  matchedTerms: string[]
  excerpts: ProjectOwnerCodeExcerpt[]
}

export interface ProjectOwnerCodeSearchResult {
  workspaceId: string
  rootFingerprint: string
  filesScanned: number
  truncated: boolean
  files: ProjectOwnerCodeFileMatch[]
}

/** 反馈关联的只读交付证据；不构成成果真实性或执行授权证明。 */
export interface ProjectOwnerDeliveryContext {
  commandId: string
  grantId: string
  priorAuthorization: ProjectOwnerDeliveryAuthorizationContext
  taskId: string
  role: 'executor' | 'reviewer'
  reworkOrdinal: number
  state: string
  acceptanceCriteria: string[]
  executionResultSummary?: string
  technicalReview?: {
    verdict: 'approved' | 'changes_requested' | 'blocked'
    summary: string
    criteria: Array<{ criterion: string; status: 'met' | 'not_met' | 'not_verified'; evidence: string }>
    findings: Array<{ severity: 'low' | 'medium' | 'high'; description: string; requestedChange: string }>
    blockerReason: string | null
  }
  feedback: string
}

/** 冻结的是规划来源，不是员工实例、执行权限或外部成果证明。 */
export interface ProjectOwnerPlanSources {
  project: { id: string; title: string; description: string }
  task?: { id: string; projectId: string; title: string; description: string }
  roles: ProjectOwnerRoleAdvice[]
  code?: ProjectOwnerCodeSearchResult
  delivery?: ProjectOwnerDeliveryContext[]
}

export interface ProjectOwnerPlanningContext {
  goal: ProjectOwnerGoalDraft
  sources: ProjectOwnerPlanSources
  fingerprint: string
}

export interface ProjectOwnerPlanInput {
  /** 从主进程取得的规划来源指纹；不能把晚到提案绑定到新来源。 */
  expectedContextFingerprint: string
  summary: string
  assumptions: string[]
  risks: string[]
  steps: ProjectOwnerPlanStep[]
  deliveryChangeAssessment?: ProjectOwnerDeliveryChangeAssessment
  changeReason: string
}

export interface ProjectOwnerPlanDraft extends ProjectOwnerGoalSubject {
  schemaVersion: 1
  revision: number
  planVersion: number
  goalRevision: number
  goalVersion: number
  /** stale由最新目标/来源派生，旧历史本身不被覆盖。 */
  state: 'proposed' | 'confirmed' | 'stale'
  actor: 'local-user' | 'system:owner-planner'
  /** generated必须有主进程可信Run回执，不接受客户端自报。 */
  origin: 'manual' | 'generated'
  sourceRun?: { receiptId: string; executionId: string; responseHash: string }
  savedAt: number
  changeReason: string
  contextFingerprint: string
  /** 内容与来源校验值；不构成签名或执行授权。 */
  planFingerprint: string
  sources: ProjectOwnerPlanSources
  proposal: ProjectOwnerPlanProposal
}

export interface ProjectOwnerPlanVersionRequest extends ProjectOwnerGoalSubject {
  expectedGoalRevision: number
  expectedRevision: number
}

export interface SaveProjectOwnerPlanRequest extends ProjectOwnerPlanVersionRequest {
  input: ProjectOwnerPlanInput
}

/** 只保存/确认内容，不收费、不派发；与目标接口分离兼容旧调用方。 */
export interface ProjectOwnerPlanApi {
  getOwnerPlanningContext: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanningContext>>
  getOwnerPlanDraft: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft | null>>
  listOwnerPlanHistory: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft[]>>
  saveOwnerPlanDraft: (request: SaveProjectOwnerPlanRequest) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft>>
  confirmOwnerPlanDraft: (request: ProjectOwnerPlanVersionRequest) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft>>
}

export interface OwnerRuntimeBinding {
  schemaVersion: 1
  projectId: string
  revision: number
  ownerRole: 'project_owner'
  ownerName: string
  carrierId: string
  workspaceId: string
  channelId: string
  modelId: string
  runtime: 'ai-sdk'
  carrierFingerprint: string
  /** 配置字段指纹；旧记录缺省时继续使用 carrierFingerprint 的历史算法核验。 */
  carrierConfigurationFingerprint?: string
  actor: 'local-user'
  savedAt: number
  changeReason: string
}
export interface OwnerPlanningLink {
  schemaVersion: 1
  id: string
  projectId: string
  requestId: string
  planningTaskId: string
  targetTaskId?: string
  bindingRevision: number
  goalRevision: number
  goalVersion: number
  planRevision: number
  contextFingerprint: string
  carrierFingerprint: string
  protocolVersion: '1' | '2' | '3'
  /** GLM-5.3 family Owner规划固定低推理强度，释放输出预算给可审阅正文。 */
  reasoningEffort?: 'low'
  promptHash: string
  purpose: 'owner_planning'
  maxRequests: 1
  maxOutputTokens: 4096 | 8192
  createdAt: number
}

export interface ProjectOwnerRunView {
  link: OwnerPlanningLink
  executions: { id: string; sessionId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'; summary: string | null }[]
  receipts: { id: string; executionId: string; capturedAt: number; responseText: string; responseHash: string; validTerminal: boolean; stopped: boolean; error: string | null; providerRequestId?: string; providerResponseId?: string; usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null } | null; cost: { source: 'runtime_reported' | 'unknown'; usd: number | null } }[]
  outcomes: { executionId: string; receiptId: string; state: 'proposed' | 'needs_clarification' | 'stale' | 'failed' | 'unknown' | 'stopped'; detail: string; planRevision?: number; clarification?: { projectId: string; taskId?: string; goalVersion: number; contextFingerprint: string; reason: string; questions: { key: string; reasonType: 'missing_information' | 'source_conflict'; question: string; why: string; options: string[]; recommended?: string; sourceReferences?: { sourceId: string; quote: string }[] }[] } }[]
}
/** 配置/准备/读取无费用；真正start仍走既有显式费用IPC，不新增自由Caller。 */
export interface ProjectOwnerRuntimeApi {
  getOwnerRuntimeBinding: (subject: { projectId: string }) => Promise<ProjectOwnerGoalResult<OwnerRuntimeBinding | null>>
  saveOwnerRuntimeBinding: (request: { projectId: string; expectedRevision: number; input: { ownerName: string; carrierId: string; workspaceId: string; changeReason: string } }) => Promise<ProjectOwnerGoalResult<OwnerRuntimeBinding>>
  prepareOwnerPlanning: (request: { projectId: string; input: { requestId: string; taskId?: string; expectedBindingRevision: number; expectedGoalRevision: number; expectedPlanRevision: number; expectedContextFingerprint: string } }) => Promise<ProjectOwnerGoalResult<OwnerPlanningLink>>
  listOwnerPlanningRuns: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerRunView[]>>
}

/** 每个计划岗位键显式绑定一个真实员工；模板建议不代表此映射或授权。 */
export interface OwnerExecutionRoleAssignment {
  roleKey: string
  employeeId: string
}
/** 可选岗位费用上限；仅收紧共享授权总额，不构成 Provider 侧硬停止。 */
export interface OwnerExecutionRoleBudgetCap {
  roleKey: string
  maxCostMicros: number
}
/** 业务执行范围准备：永久保持pending，不是授权、余额或派工命令。 */
export interface OwnerExecutionPreparationInput {
  requestId: string
  expectedPreparationRevision: number
  expectedPolicyRevision: number | null
  expectedGoalRevision: number
  expectedPlanRevision: number
  selectedStepKeys: string[]
  executionKind: 'development' | 'controlled'
  developmentScope?: import('./development-review').DevelopmentTaskScope
  /** 兼容旧准备；新输入同时提供按稳定 roleKey 显式绑定的数组。 */
  executorEmployeeId: string
  reviewerEmployeeId: string
  roleAssignments?: OwnerExecutionRoleAssignment[]
  /** 手动配置与有效Owner默认配置不同时，必须逐项明确确认并随准备快照冻结。 */
  acknowledgeOwnerConfigurationOverride?: boolean
  /** 手动工作区与有效Owner绑定工作区不同时，必须明确确认并随准备快照冻结。 */
  acknowledgeOwnerWorkspaceOverride?: boolean
  /** 未列出的岗位只受共享 maxCostMicros 限制；空数组按未配置处理。 */
  roleBudgetCaps?: OwnerExecutionRoleBudgetCap[]
  workspaceId: string
  knowledgeSourceIds: string[]
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
  changeReason: string
}
export interface OwnerExecutionPreparationReference {
  schemaVersion: 1
  purpose: 'owner_business_execution_preparation'
  id: string
  revision: number
  integrityHash: string
  stage: 'pending_task_links'
}
export interface OwnerExecutionPreparationSource extends ProjectOwnerGoalSubject {
  ownerBindingProvenance: { state: 'none' } | { state: 'bound'; bindingRevision: number; carrierId: string; carrierFingerprint: string; bindingHash: string }
  schemaVersion: 1
  stage: 'pending_task_links'
  goalRevision: number
  goalVersion: number
  planRevision: number
  planVersion: number
  planFingerprint: string
  contextFingerprint: string
  plan: ProjectOwnerPlanDraft
  selectedStepKeys: string[]
  /** 根据步骤文本与所选工作区能力元数据生成的可解释候选；不构成工具授权。 */
  toolRecommendations: import('../utils/project-owner-tool-recommendations').OwnerStepToolRecommendation[]
  /** 新版每个 roleKey 的实际员工及配置摘要；legacy 准备缺省并沿用单一 executor。 */
  roleAssignments?: Array<{ roleKey: string; employee: { id: string; name: string; roleTemplateId?: string; configurationHash: string } }>
  executor: { id: string; name: string; configurationHash: string }
  reviewer: { id: string; name: string; configurationHash: string }
  workspaceId: string
  workspaceName: string
  workspaceHash: string
  targetTaskHash?: string
  repositoryIdentityHash?: string
  channelId: string
  modelId: string
  runtime: string
  channelHash: string
  capabilityConfigurationHash: string
  developmentScope?: import('./development-review').DevelopmentTaskScope
  knowledgeSources: Array<{ id: string; name: string; knowledgeBaseIds: string[]; metadataHash: string; contentHash: null }>
  /** 资料清单未接执行侧fence；不冒充实际工具访问授权。 */
  blockers: string[]
}
export interface OwnerExecutionPreparationPreview extends OwnerExecutionPreparationSource {
  input: OwnerExecutionPreparationInput
  previewFingerprint: string
}
export interface OwnerExecutionPreparationRecord {
  schemaVersion: 1
  id: string
  projectId: string
  taskId?: string
  revision: number
  policyRevision: number
  stage: 'pending_task_links'
  actor: 'local-user'
  savedAt: number
  input: OwnerExecutionPreparationInput
  source: OwnerExecutionPreparationSource
  inputHash: string
  previousIntegrityHash: string | null
  integrityHash: string
}
export interface OwnerExecutionPreparationView {
  choices: { employees: Array<{ id: string; name: string; roleTemplateId?: string; executionProfile: string; workspaceIds: string[]; channelId: string; modelId?: string; runtime: string; isOwnerCarrier?: boolean }>; workspaces: Array<{ id: string; name: string }>; workspaceCapabilities: Array<{ workspaceId: string; mcpServers: Array<{ name: string; type: string }>; skills: Array<{ slug: string; name: string; description?: string }> }>; knowledgeSources: Array<{ id: string; name: string }> }
  workspaceRecommendation: { workspaceId?: string; source: 'owner_binding' | 'unique_project_workspace' | 'ambiguous' | 'none' | 'owner_binding_unavailable' }
  executionConfigurationRecommendation: { channelId: string; modelId: string; runtime: string; source: 'owner_binding' } | null
  executionConfigurationRecommendationState: 'current' | 'stale' | 'none'
  revision: number
  policyRevision: number | null
  preparation: OwnerExecutionPreparationRecord | null
  status: 'none' | 'current' | 'stale' | 'unapplied' | 'other_subject'
  blockers: string[]
}

export interface PreviewOwnerExecutionPreparationRequest extends ProjectOwnerGoalSubject { input: OwnerExecutionPreparationInput }
export interface SaveOwnerExecutionPreparationRequest extends PreviewOwnerExecutionPreparationRequest { previewFingerprint: string }
export interface ProjectOwnerExecutionPreparationApi {
  getOwnerExecutionPreparation: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionPreparationView>>
  listOwnerExecutionPreparationHistory: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionPreparationRecord[]>>
  previewOwnerExecutionPreparation: (request: PreviewOwnerExecutionPreparationRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionPreparationPreview>>
  saveOwnerExecutionPreparation: (request: SaveOwnerExecutionPreparationRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionPreparationRecord>>
}

/** AO06仅落地暂停Task，不代表准备、授权或已安排运行。 */
export interface OwnerTaskMaterializationInput {
  requestId: string
  expectedMaterializationRevision: number
  expectedPreparationId: string
  expectedPreparationRevision: number
  expectedPreparationHash: string
  expectedPolicyRevision: number
}
export interface OwnerTaskProjection {
  stepKey: string
  targetTaskId?: string
  title: string
  description: string
  roleKey: string
  outcome: string
  acceptanceCriteria: string[]
  dependencies: string[]
  assignee: { userId: string; displayName: string }
  workspaceId: string
  developmentScope?: import('./development-review').DevelopmentTaskScope
  /** 更新为Agent负责人时清除旧成员目录键，不能沿用旧人类身份。 */
  clearAssigneeMemberId?: true
  previous?: { status: string; assignee?: { userId: string; displayName: string }; assigneeMemberId?: string; workspaceId?: string; developmentScope?: import('./development-review').DevelopmentTaskScope }
}
export interface OwnerTaskMaterializationPreview extends ProjectOwnerGoalSubject {
  input: OwnerTaskMaterializationInput
  preparation: OwnerExecutionPreparationRecord
  projections: OwnerTaskProjection[]
  targetTaskHash?: string
  targetDependenciesHash?: string
  previewFingerprint: string
}
export interface OwnerTaskStepLink {
  id: string
  materializationId: string
  projectId: string
  subjectKey: string
  planFingerprint: string
  stepKey: string
  taskId: string
  kind: 'created' | 'existing_target'
  projection: OwnerTaskProjection
  taskSpecificationHash: string
  dependencies: Array<{ id: string; taskId: string; dependsOnTaskId: string; type: string }>
  integrityHash: string
}
export interface OwnerTaskMaterializationRecord extends ProjectOwnerGoalSubject {
  schemaVersion: 1
  purpose: 'owner_business_task_materialization'
  id: string
  revision: number
  actor: 'local-user'
  savedAt: number
  stage: 'paused_materialized_needs_revalidation'
  input: OwnerTaskMaterializationInput
  inputHash: string
  preview: OwnerTaskMaterializationPreview
  links: OwnerTaskStepLink[]
  previousIntegrityHash: string | null
  integrityHash: string
}
export interface OwnerTaskMaterializationView {
  revision: number
  materialization: OwnerTaskMaterializationRecord | null
  status: 'none' | 'needs_revalidation' | 'stale'
  blockers: string[]
}
export interface PreviewOwnerTaskMaterializationRequest extends ProjectOwnerGoalSubject { input: OwnerTaskMaterializationInput }
export interface MaterializeOwnerTasksRequest extends PreviewOwnerTaskMaterializationRequest { previewFingerprint: string }
export interface ProjectOwnerTaskMaterializationApi {
  getOwnerTaskMaterialization: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerTaskMaterializationView>>
  listOwnerTaskMaterializationHistory: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerTaskMaterializationRecord[]>>
  previewOwnerTaskMaterialization: (request: PreviewOwnerTaskMaterializationRequest) => Promise<ProjectOwnerGoalResult<OwnerTaskMaterializationPreview>>
  materializeOwnerTasks: (request: MaterializeOwnerTasksRequest) => Promise<ProjectOwnerGoalResult<OwnerTaskMaterializationRecord>>
}

/** 材料化后重新验证输入；预算/期限从v1原样携带，不重开授权窗口。 */
export interface OwnerExecutionRevalidationInput {
  requestId: string
  expectedRevalidationRevision: number
  expectedMaterializationId: string
  expectedMaterializationRevision: number
  expectedMaterializationHash: string
  expectedPolicyRevision: number
  changeReason: string
}
export interface OwnerExecutionRevalidationTask {
  taskId: string
  stepKey: string
  linkId: string
  linkKind: 'created' | 'existing_target'
  linkIntegrityHash: string
  taskSpecificationHash: string
  status: 'paused'
  assignee: { userId: string; displayName: string }
  /** 新版按步骤冻结的实际执行员工；legacy 任务缺省并沿用 source.executor。 */
  executor?: { id: string; name: string; roleKey: string; configurationHash: string }
  workspaceId: string
  developmentScope?: import('./development-review').DevelopmentTaskScope
  dependencies: Array<{ id: string; taskId: string; dependsOnTaskId: string; type: string }>
}
export interface OwnerExecutionRevalidationSource {
  schemaVersion: 2
  stage: 'paused_task_links'
  projectId: string
  taskId?: string
  materialization: { id: string; revision: number; integrityHash: string }
  originalPreparation: { id: string; revision: number; integrityHash: string; policyRevision: number }
  planRevision: number
  planVersion: number
  planFingerprint: string
  contextFingerprint: string
  selectedStepKeys: string[]
  tasks: OwnerExecutionRevalidationTask[]
  executor: { id: string; name: string; configurationHash: string }
  reviewer: { id: string; name: string; configurationHash: string }
  workspaceId: string
  workspaceName: string
  workspaceHash: string
  channelId: string
  modelId: string
  runtime: string
  channelHash: string
  capabilityConfigurationHash: string
  repositoryIdentityHash?: string
  ownerBindingProvenance: OwnerExecutionPreparationSource['ownerBindingProvenance']
  knowledgeSources: OwnerExecutionPreparationSource['knowledgeSources']
  budget: { maxCostMicros: number; maxRuns: number; maxRework: number; expiresAt: number; roleBudgetCaps?: OwnerExecutionRoleBudgetCap[] }
  executionKind: 'development' | 'controlled'
  blockers: string[]
}
export interface OwnerExecutionRevalidationPreview extends ProjectOwnerGoalSubject {
  input: OwnerExecutionRevalidationInput
  source: OwnerExecutionRevalidationSource
  previewFingerprint: string
}
export interface OwnerExecutionRevalidationRecord extends ProjectOwnerGoalSubject {
  schemaVersion: 2
  purpose: 'owner_business_execution_revalidation'
  id: string
  revision: number
  policyRevision: number
  stage: 'paused_task_links'
  actor: 'local-user'
  savedAt: number
  input: OwnerExecutionRevalidationInput
  source: OwnerExecutionRevalidationSource
  inputHash: string
  previewFingerprint: string
  previousIntegrityHash: string | null
  integrityHash: string
}
export interface OwnerExecutionRevalidationView {
  revision: number
  revalidation: OwnerExecutionRevalidationRecord | null
  status: 'none' | 'needs_revalidation' | 'current' | 'stale' | 'unapplied'
  blockers: string[]
}
export interface OwnerExecutionRevalidationReference {
  schemaVersion: 1
  purpose: 'owner_business_execution_revalidation'
  id: string
  revision: number
  integrityHash: string
  stage: 'paused_task_links'
  materializationId: string
  materializationIntegrityHash: string
}
export interface PreviewOwnerExecutionRevalidationRequest extends ProjectOwnerGoalSubject { input: OwnerExecutionRevalidationInput }
export interface SaveOwnerExecutionRevalidationRequest extends PreviewOwnerExecutionRevalidationRequest { previewFingerprint: string }
export interface ProjectOwnerExecutionRevalidationApi {
  getOwnerExecutionRevalidation: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionRevalidationView>>
  listOwnerExecutionRevalidationHistory: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionRevalidationRecord[]>>
  previewOwnerExecutionRevalidation: (request: PreviewOwnerExecutionRevalidationRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionRevalidationPreview>>
  saveOwnerExecutionRevalidation: (request: SaveOwnerExecutionRevalidationRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionRevalidationRecord>>
}

/** Owner执行授权账本：发行记录是"允许按账本消费"的静态许可，不创建命令/执行/会话，不调用Provider。 */
export interface OwnerExecutionGrantBudget { maxCostMicros: number; maxRuns: number; maxRework: number; expiresAt: number; roleBudgetCaps?: OwnerExecutionRoleBudgetCap[] }
export type OwnerExecutionDispatchMode = 'manual' | 'autonomous'
export interface OwnerExecutionGrantIssuePreview extends ProjectOwnerGoalSubject {
  dispatchMode: OwnerExecutionDispatchMode
  policyRevision: number
  revalidationId: string
  revalidationRevision: number
  revalidationIntegrityHash: string
  materializationId: string
  materializationRevision: number
  materializationIntegrityHash: string
  sourceHash: string
  /** grant范围内每个roleKey的冻结执行员工；sourceHash同时绑定其配置摘要。 */
  roleAssignments?: Array<{ roleKey: string; employeeId: string; employeeName: string }>
  executorEmployeeId: string
  reviewerEmployeeId: string
  workspaceId: string
  channelId: string
  modelId: string
  runtime: string
  budget: OwnerExecutionGrantBudget
  blockers: string[]
  approvalFingerprint: string
}
export interface OwnerExecutionGrant extends OwnerExecutionGrantIssuePreview {
  grantId: string
  state: 'active' | 'paused' | 'needs_reconcile' | 'archived'
  issuedAt: number
}
export interface OwnerExecutionGrantRevokePreview {
  grantId: string
  projectId: string
  fingerprint: string
  impact: { commandCount: number; runningCount: number; pendingRequestCount: number }
  blockers: string[]
}
export interface PreviewOwnerExecutionGrantIssueRequest extends ProjectOwnerGoalSubject {
  input: { requestId: string; expectedRevalidationRevision: number; expectedPolicyRevision: number; dispatchMode?: OwnerExecutionDispatchMode }
}
export interface ConfirmOwnerExecutionGrantIssueRequest extends PreviewOwnerExecutionGrantIssueRequest {
  preview: OwnerExecutionGrantIssuePreview
  confirmedFingerprint: string
}
export interface PreviewOwnerExecutionGrantRevokeRequest extends ProjectOwnerGoalSubject { grantId: string }
export interface ConfirmOwnerExecutionGrantRevokeRequest extends PreviewOwnerExecutionGrantRevokeRequest { confirmedFingerprint: string }
export interface ProjectOwnerExecutionGrantApi {
  getOwnerExecutionGrant: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionGrant | null>>
  listOwnerExecutionGrantHistory: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionGrant[]>>
  previewOwnerExecutionGrantIssue: (request: PreviewOwnerExecutionGrantIssueRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionGrantIssuePreview>>
  confirmOwnerExecutionGrantIssue: (request: ConfirmOwnerExecutionGrantIssueRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionGrant>>
  previewOwnerExecutionGrantRevoke: (request: PreviewOwnerExecutionGrantRevokeRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionGrantRevokePreview>>
  confirmOwnerExecutionGrantRevoke: (request: ConfirmOwnerExecutionGrantRevokeRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionGrant>>
}


/** Owner命令链（Stage B）：ack→reserve/queue→claim/start→逐请求→结算。默认无真实Provider。 */
export type OwnerExecutionCommandRole = 'executor' | 'reviewer'
export interface OwnerExecutionCommandAckPreview extends ProjectOwnerGoalSubject {
  grantId: string
  taskId: string
  stepLinkId: string
  employeeId: string
  employeeName: string
  roleKey?: string
  role: OwnerExecutionCommandRole
  reworkOrdinal: number
  sourceVersion: number
  sourceHash: string
  derivedReservationMicros: number
  remainingCostMicros: number
  remainingRuns: number
  roleBudgetCapMicros?: number
  remainingRoleCostMicros?: number
  expiresAt: number
  blockers: string[]
  ackFingerprint: string
}
export interface PreviewOwnerExecutionCommandAckRequest extends ProjectOwnerGoalSubject {
  input: { grantId: string; taskId: string; role: OwnerExecutionCommandRole; reworkOrdinal: number; expectedRevalidationRevision: number }
}
export interface AcknowledgeOwnerExecutionCommandRequest extends PreviewOwnerExecutionCommandAckRequest {
  preview: OwnerExecutionCommandAckPreview
  confirmedFingerprint: string
  acknowledgeModelCosts: boolean
}
export interface OwnerExecutionCommandReservationInput {
  requestId: string
  grantId: string
  taskId: string
  role: OwnerExecutionCommandRole
  reworkOrdinal: number
  expectedRevalidationRevision: number
}
export interface OwnerExecutionCommandAcknowledgement {
  input: PreviewOwnerExecutionCommandAckRequest['input']
  preview: OwnerExecutionCommandAckPreview
  confirmedFingerprint: string
  acknowledgeModelCosts: boolean
}
export interface QueueOwnerExecutionCommandRequest extends ProjectOwnerGoalSubject {
  input: OwnerExecutionCommandReservationInput
  acknowledgement: OwnerExecutionCommandAcknowledgement
}
export interface OwnerPreflightReconciliationAudit {
  evidenceKind: 'typed_preflight' | 'legacy_operator_attested'
  reasonCode: string
  errorSha256: string
  providerConsoleCheckedNoUsage: true
  preReconciliationUsageMarker: 'none' | 'runtime_unknown'
  actor: 'local-user'
  createdAt: number
}
export interface OwnerPreflightReconciliationPreview extends ProjectOwnerGoalSubject {
  commandId: string
  grantId: string
  executionId: string
  channelId: string
  modelId: string
  provider: ProviderType
  evidenceKind: 'typed_preflight' | 'legacy_operator_attested'
  reasonCode: string
  errorMessage: string
  errorSha256: string
  reservedCostMicros: number
  requestReservationCount: 0
  preReconciliationUsageMarker: 'none' | 'runtime_unknown'
  preReconciliationUsageEvidenceSha256: string | null
  preReconciliationUsageRecordKeySha256: string | null
  runReservationsReleased: 1
  grantWillPause: true
  providerConsoleAttestationRequired: true
  fingerprint: string
}
export interface OwnerPreflightReconciliationResult {
  commandId: string
  reconciliationId: string
  state: 'released'
  actualCostMicros: 0
  grantState: 'paused'
  evidenceKind: 'typed_preflight' | 'legacy_operator_attested'
  alreadyApplied: boolean
}
export interface OwnerPreflightReconciliationPreviewRequest extends ProjectOwnerGoalSubject {
  commandId: string
}
export interface ConfirmOwnerPreflightReconciliationRequest extends ProjectOwnerGoalSubject {
  commandId: string
  confirmedFingerprint: string
  providerConsoleCheckedNoUsage: boolean
}
export interface OwnerExecutionCommandView {
  commandId: string
  grantId: string
  taskId: string
  taskTitle: string
  employeeId: string
  role: OwnerExecutionCommandRole
  reworkOrdinal: number
  state: 'reserved' | 'queued' | 'running' | 'settled' | 'released' | 'needs_reconcile' | 'unknown' | 'failed' | 'cancelled'
  executionId: string | null
  executionStatus: string | null
  /** 仅来自命令所绑定 execution 的回报摘要；属于执行者自述，不是独立验证结果。 */
  executionResultSummary?: string
  /** 本地逐次审批记录；只公开工具名、指纹与裁决，不包含工具参数正文。 */
  actionApprovals?: Array<{
    requestId: string
    toolName: string
    actionFingerprint: string
    status: 'pending' | 'allowed' | 'denied' | 'invalidated'
    requestedAt: number
    decidedAt: number | null
    decidedBy: string | null
    reason: string | null
  }>
  /** 从不可变 Owner step link 回读的冻结验收标准。 */
  acceptanceCriteria: string[]
  /** 只含与本命令关联的、通过完整性核验的结构化技术评审。 */
  technicalReview?: {
    verdict: 'approved' | 'changes_requested' | 'blocked'
    summary: string
    criteria: Array<{ criterion: string; status: 'met' | 'not_met' | 'not_verified'; evidence: string }>
    findings: Array<{ severity: 'low' | 'medium' | 'high'; description: string; requestedChange: string }>
    blockerReason: string | null
  }
  reservedCostMicros: number
  actualCostMicros: number | null
  grantAuthorization: ProjectOwnerDeliveryAuthorizationContext
  /** 命令归属的计划岗位；legacy 命令可能缺少。 */
  budgetRoleKey?: string
  preflightReconciliation?: OwnerPreflightReconciliationAudit
  ackFingerprint: string
  createdAt: number
  updatedAt: number
}
export interface DispatchOwnerExecutionCommandRequest {
  commandId: string
  ackFingerprint: string
  acknowledgeExecution: boolean
}
export type OwnerExecutionAutonomousScheduleState = 'no_grant' | 'manual' | 'paused' | 'needs_reconcile' | 'expired' | 'archived' | 'stale' | 'ready' | 'running' | 'waiting'
export type OwnerTechnicalReviewVerdict = 'approved' | 'changes_requested' | 'blocked'
export type OwnerExecutionNextAction = 'execute' | 'review' | 'rework' | 'await_business_acceptance' | 'human_decision' | 'none'
export interface OwnerExecutionAutonomousScheduleStatus {
  projectId: string
  state: OwnerExecutionAutonomousScheduleState
  grantId?: string
  taskId?: string
  role?: OwnerExecutionCommandRole
  reservedCostMicros: number
  committedCostMicros: number
  runReservations: number
  reason: string
  reworkOrdinal?: number
  reviewVerdict?: OwnerTechnicalReviewVerdict
  reviewSummary?: string
  reviewFindings?: string[]
  nextAction?: OwnerExecutionNextAction
}
export interface ProjectOwnerExecutionCommandApi {
  getOwnerAutonomousScheduleStatus: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionAutonomousScheduleStatus>>
  previewOwnerExecutionCommandAck: (request: PreviewOwnerExecutionCommandAckRequest) => Promise<ProjectOwnerGoalResult<OwnerExecutionCommandAckPreview>>
  queueOwnerExecutionCommand: (request: QueueOwnerExecutionCommandRequest) => Promise<ProjectOwnerGoalResult<{ commandId: string; executionId: string }>>
  listOwnerExecutionCommands: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<OwnerExecutionCommandView[]>>
  dispatchOwnerExecutionCommand: (request: DispatchOwnerExecutionCommandRequest) => Promise<ProjectOwnerGoalResult<{ commandId: string; executionId: string; started: boolean }>>
  cancelQueuedOwnerExecutionCommand: (request: { commandId: string }) => Promise<ProjectOwnerGoalResult<{ commandId: string }>>
  previewOwnerPreflightReconciliation: (request: OwnerPreflightReconciliationPreviewRequest) => Promise<ProjectOwnerGoalResult<OwnerPreflightReconciliationPreview>>
  confirmOwnerPreflightReconciliation: (request: ConfirmOwnerPreflightReconciliationRequest) => Promise<ProjectOwnerGoalResult<OwnerPreflightReconciliationResult>>
}
