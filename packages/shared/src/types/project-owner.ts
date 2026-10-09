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
}

export interface ProjectOwnerGoalBrief extends ProjectOwnerGoalSubject {
  goalVersion: number
  objective: string
  constraints: string[]
  acceptanceCriteria: string[]
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
}

export interface ProjectOwnerPlanProposal extends ProjectOwnerGoalSubject {
  goalVersion: number
  mode: 'proposal_only'
  summary: string
  assumptions: string[]
  risks: string[]
  steps: ProjectOwnerPlanStep[]
}

export interface ProjectOwnerRoleAdvice {
  key: string
  name: string
  version: string
  sourceSha256: string
  rulesSha256: string
}

/** 冻结的是规划来源，不是员工实例、执行权限或外部成果证明。 */
export interface ProjectOwnerPlanSources {
  project: { id: string; title: string; description: string }
  task?: { id: string; projectId: string; title: string; description: string }
  roles: ProjectOwnerRoleAdvice[]
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
  protocolVersion: '1'
  promptHash: string
  purpose: 'owner_planning'
  maxRequests: 1
  maxOutputTokens: 4096
  createdAt: number
}

export interface ProjectOwnerRunView {
  link: OwnerPlanningLink
  executions: { id: string; sessionId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'; summary: string | null }[]
  receipts: { id: string; executionId: string; capturedAt: number; responseText: string; responseHash: string; validTerminal: boolean; stopped: boolean; error: string | null; usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null } | null; cost: { source: 'runtime_reported' | 'unknown'; usd: number | null } }[]
  outcomes: { executionId: string; receiptId: string; state: 'proposed' | 'needs_clarification' | 'stale' | 'failed' | 'unknown' | 'stopped'; detail: string; planRevision?: number; clarification?: { reason: string; questions: { key: string; question: string; why: string; options: string[] }[] } }[]
}
/** 配置/准备/读取无费用；真正start仍走既有显式费用IPC，不新增自由Caller。 */
export interface ProjectOwnerRuntimeApi {
  getOwnerRuntimeBinding: (subject: { projectId: string }) => Promise<ProjectOwnerGoalResult<OwnerRuntimeBinding | null>>
  saveOwnerRuntimeBinding: (request: { projectId: string; expectedRevision: number; input: { ownerName: string; carrierId: string; workspaceId: string; changeReason: string } }) => Promise<ProjectOwnerGoalResult<OwnerRuntimeBinding>>
  prepareOwnerPlanning: (request: { projectId: string; input: { requestId: string; taskId?: string; expectedBindingRevision: number; expectedGoalRevision: number; expectedPlanRevision: number; expectedContextFingerprint: string } }) => Promise<ProjectOwnerGoalResult<OwnerPlanningLink>>
  listOwnerPlanningRuns: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerRunView[]>>
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
  executorEmployeeId: string
  reviewerEmployeeId: string
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
  choices: { employees: Array<{ id: string; name: string; executionProfile: string; workspaceIds: string[]; channelId: string; modelId?: string; runtime: string }>; workspaces: Array<{ id: string; name: string }>; knowledgeSources: Array<{ id: string; name: string }> }
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
