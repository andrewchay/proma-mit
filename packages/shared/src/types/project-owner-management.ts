import type { ProjectOwnerGoalDraft, ProjectOwnerGoalResult } from './project-owner'

/** 项目管理身份与业务执行/付费许可分开；创建身份不赋予任何执行权限。 */
export interface ProjectOwnerManager {
  schemaVersion: 1
  projectId: string
  ownerId: string
  conversationId: string
  revision: number
  status: 'active' | 'paused'
  createdAt: number
  updatedAt: number
}

export interface OwnerManagementEvent {
  id: string
  projectId: string
  kind: 'goal_saved' | 'binding_changed' | 'plan_confirmed' | 'delegation_confirmed' | 'assignment_recheck' | 'planning_result' | 'assignment_result' | 'message_received' | 'answer_saved' | 'execution_observed' | 'team_changed'
  taskId?: string
  sourceId?: string
  sourceRevision: number
  createdAt: number
  consumedAt: number | null
}

export interface OwnerManagementMessage {
  id: string
  projectId: string
  conversationId: string
  eventId: string
  role: 'user' | 'assistant'
  kind: 'goal' | 'configuration_required' | 'planning_confirmation' | 'attention' | 'clarification' | 'answer' | 'plan_proposal' | 'management_progress' | 'execution_arranged' | 'conversation' | 'reply' | 'change_proposal' | 'change_decision' | 'execution_observation' | 'employee_interaction' | 'delivery'
  employeeInteraction?: import('./project-owner-employee-interaction').OwnerEmployeeInteraction
  /** 失败请求的结构化证据；只来自本地回执，不含账单确认。 */
  runEvidence?: OwnerRunEvidence
  executionObservation?: OwnerExecutionObservation
  delivery?: OwnerManagementDelivery
  deliveryReference?: OwnerManagementDeliveryReference
  content: string
  taskId?: string
  goalRevision?: number
  planningTaskId?: string
  questionId?: string
  changeId?: string
  changeDecision?: OwnerConversationChangeDecision
  teamWorkspaceProposal?: OwnerTeamWorkspaceProposal
  teamWorkspaceApproval?: { sourceMessageId: string; workspaceId: string; scopeFingerprint: string }
  createdAt: number
}

export interface OwnerRunEvidence {
  inputTokens: number | null
  outputTokens: number | null
  costSource: 'runtime_reported' | 'unknown'
  costUsd: number | null
  stopped: boolean
  autoRetried: false
}

/** Owner提出的项目资料范围建议；只有用户确认后才会绑定工作区。 */
export interface OwnerTeamWorkspaceProposal {
  workspaceId: string
  workspaceName: string
  eligibleEmployeeCount: number
  scopeFingerprint: string
}
export interface ConfirmOwnerTeamWorkspaceAccessRequest {
  projectId: string
  taskId?: string
  messageId: string
  workspaceId: string
  scopeFingerprint: string
}

/** 用户修改意见明确指向的既有Owner验收成果。 */
export interface OwnerManagementDeliveryReference { messageId: string; artifactHash: string; stepKey?: string }

/** 经Owner验收后交回项目对话的成果快照；正文仍是员工原始交付，不代表外部事实已证实。 */
export interface OwnerManagementDelivery {
  schemaVersion: 1
  planVersion: number
  items: OwnerManagementDeliveryItem[]
}
export interface OwnerManagementDeliveryItem {
  stepKey: string
  title: string
  acceptanceCriteria: string[]
  artifactHash: string
  content: string
  ownerDecision: string
  reviewerSummary: string
}

export type OwnerManagementTracePhase = 'assignment_preparation' | 'assignment_run' | 'execution_start' | 'executor' | 'reviewer' | 'owner_quality' | 'owner_response'
export type OwnerManagementTraceState = 'started' | 'queued' | 'completed' | 'failed' | 'blocked' | 'waiting' | 'stalled' | 'expired'
export type OwnerManagementTraceDetailCode = 'team_check' | 'provider_pending' | 'result_ready' | 'start_verified' | 'no_update' | 'grant_expired' | 'decision_required' | 'authorization_changed' | 'claim_without_fact'

/** 本地诊断白名单；eventId 对外呈现为单向摘要，禁止附带Prompt、模型回复、思维链、凭证或任意正文。 */
export interface OwnerManagementTraceEntry {
  eventId: string
  projectId: string
  taskId?: string
  phase: OwnerManagementTracePhase
  state: OwnerManagementTraceState
  createdAt: number
  detailCode?: OwnerManagementTraceDetailCode
}

export interface OwnerManagementView {
  manager: ProjectOwnerManager | null
  messages: OwnerManagementMessage[]
  pendingEvents: number
  /** 仅持久审批账本中仍绑定运行中Owner执行的请求身份；参数只从实时权限队列读取。 */
  actionRequests?: Array<{ requestId: string; sessionId: string; taskId: string }>
  employeeInteractions?: import('./project-owner-employee-interaction').OwnerEmployeeInteraction[]
  /** 可重建状态投影摘要；只读展示，未出现待处理变化时不代表已调用模型。 */
  stateProjection?: { stateHash: string; dirtyDomains: string[]; lastReconciledAt: number }
  questions: OwnerManagementQuestion[]
  changes?: OwnerConversationChangeView[]
  trace?: OwnerManagementTraceEntry[]
}

export interface SendOwnerManagementMessageRequest {
  projectId: string
  taskId?: string
  conversationId: string
  requestId: string
  expectedGoalRevision: number
  content: string
  deliveryReference?: OwnerManagementDeliveryReference
}

export interface OwnerConversationGoalContent { objective: string; constraints: string[]; acceptanceCriteria: string[] }
export type OwnerConversationChange = { kind: 'clarification_answers'; questionId: string; answers: Record<string, string> }
  | { kind: 'goal_revision'; goal: OwnerConversationGoalContent }
export interface OwnerConversationChangeView {
  id: string
  projectId: string
  taskId?: string
  conversationId: string
  messageId: string
  goalRevision: number
  summary: string
  change: OwnerConversationChange
  currentGoal: OwnerConversationGoalContent
  questions: Array<{ key: string; question: string }>
  previewHash: string
  state: 'pending' | 'applied' | 'dismissed' | 'stale'
}
export interface OwnerConversationChangeDecision {
  changeId: string
  requestId: string
  action: 'apply' | 'dismiss'
  previewHash: string
  goalRevision?: number
  goalHash?: string
}
export interface DecideOwnerConversationChangeRequest {
  projectId: string
  changeId: string
  requestId: string
  action: 'apply' | 'dismiss'
  previewHash: string
}
export interface OwnerConversationChangeResult { changeId: string; action: 'apply' | 'dismiss'; goal?: ProjectOwnerGoalDraft }

export interface OwnerManagementApi {
  decideOwnerConversationChange: (request: DecideOwnerConversationChangeRequest) => Promise<ProjectOwnerGoalResult<OwnerConversationChangeResult>>
  sendOwnerManagementMessage: (request: SendOwnerManagementMessageRequest) => Promise<ProjectOwnerGoalResult<OwnerManagementMessage>>
  previewOwnerManagementDelegation: (request: OwnerManagementDelegationInput) => Promise<ProjectOwnerGoalResult<OwnerManagementDelegationPreview>>
  confirmOwnerManagementDelegation: (request: { input: OwnerManagementDelegationInput; previewHash: string }) => Promise<ProjectOwnerGoalResult<OwnerManagementDelegation>>
  getOwnerManagementDelegation: (request: { projectId: string; taskId?: string }) => Promise<ProjectOwnerGoalResult<OwnerManagementDelegationView>>
  revokeOwnerManagementDelegation: (request: { projectId: string; delegationId: string }) => Promise<ProjectOwnerGoalResult<OwnerManagementDelegationView>>
  onOwnerManagementChanged: (callback: (change: { projectId: string; messageId?: string }) => void) => () => void
  answerOwnerManagementQuestion: (request: AnswerOwnerManagementQuestionRequest) => Promise<ProjectOwnerGoalResult<ProjectOwnerGoalDraft>>
  getOwnerManagement: (request: { projectId: string }) => Promise<ProjectOwnerGoalResult<OwnerManagementView>>
  /** 仅在已确认方案与有效授权下重排一次；请求ID保证幂等。 */
  retakeOwnerAssignment: (request: { projectId: string; taskId?: string; requestId: string }) => Promise<ProjectOwnerGoalResult<{ enqueued: boolean }>>
  confirmOwnerTeamWorkspaceAccess: (request: ConfirmOwnerTeamWorkspaceAccessRequest) => Promise<ProjectOwnerGoalResult<void>>
  /** 仅暂停/恢复管理循环，不代表撤销业务授权或停止已启动员工。 */
  setOwnerManagementStatus: (request: { projectId: string; expectedRevision: number; status: 'active' | 'paused' }) => Promise<ProjectOwnerGoalResult<ProjectOwnerManager>>
}

/** 保存模型提出的完整问题与来源；状态从精确答复及当前来源派生。 */
export interface OwnerManagementQuestion {
  id: string
  projectId: string
  taskId?: string
  conversationId: string
  executionId: string
  receiptId: string
  planningTaskId: string
  goalRevision: number
  contextFingerprint: string
  reason: string
  questions: ProjectOwnerClarificationQuestion[]
  state: 'open' | 'answered' | 'stale'
}

export interface ProjectOwnerClarificationQuestion {
  key: string
  reasonType: 'missing_information' | 'source_conflict'
  question: string
  why: string
  options: string[]
  recommended?: string
  sourceReferences?: { sourceId: string; quote: string }[]
}

export interface AnswerOwnerManagementQuestionRequest {
  projectId: string
  questionId: string
  requestId: string
  expectedGoalRevision: number
  expectedContextFingerprint: string
  answers: Record<string, string>
}

/** 管理委托只覆盖受限Owner推理；不授予员工执行或敏感操作许可。金额单位micro-USD。 */
export interface OwnerManagementDelegationInput {
  projectId: string
  taskId?: string
  requestId: string
  maxRequests: number
  /** 新授权允许在项目总额内自主组织员工；旧委托缺省为 false，避免静默扩权。 */
  autonomousExecution?: true
  maxCostMicros: number
  expiresAt: number
  /** 旧版委托兼容字段；新授权不绑定单份方案。 */
  startApproval?: { expectedGoalRevision: number; expectedPlanRevision: number; planFingerprint: string; contextFingerprint: string }
}
export interface OwnerManagementDelegationPreview extends OwnerManagementDelegationInput {
  /** 新确认明确包含持续对话；旧委托不隐式扩权。 */
  conversationEnabled?: true
  /** 新委托明确覆盖业务执行结果及停滞的后台分析；不授予业务动作许可。 */
  executionFollowupEnabled?: true
  /** 新确认允许将准确完整文本成果及逐项评审送入Owner；旧委托不升级。 */
  fullDeliveryReviewEnabled?: true
  /** 允许Owner提出结构化质量决定；实际动作仍需当前业务授权。 */
  qualityDecisionEnabled?: true
  scopeHash: string
  goalContentHash: string
  previewHash: string
  bindingRevision: number
  goalRevision: number
  modelId: string
  workspaceName: string
  priceEvidenceId: string
  perRequestCeilingMicros: number
  /** 兼容旧授权记录（8192）与 GLM 长推理协议（32768）。 */
  maxOutputTokens: 8192 | 32768
}

/** 后台从准确Owner命令读取；回报与技术评审是分析资料，不是成果已验证的证明。 */
export interface OwnerExecutionObservation {
  executionId: string
  commandId: string
  grantId: string
  sourcePlanRevision: number
  businessTaskId: string
  taskTitle: string
  role: 'executor' | 'reviewer'
  trigger: 'terminal' | 'stalled' | 'expired'
  /** 停滞冻结最后心跳，到期冻结许可期限；恢复后再次停滞必须形成新观察。 */
  conditionTimestamp?: number
  executionStatus: string
  commandState: string
  grantState: string
  completedAt?: number
  resultSummary: string
  error: string
  actualCostMicros: number | null
  reservedCostMicros: number
  /** 该命令实际发出的模型请求数；为 0 表示失败发生在发送之前，没有产生模型费用。 */
  requestsSent?: number
  review?: { verdict: string; summary: string; findings: string[] }
}
export interface OwnerManagementDelegation extends OwnerManagementDelegationPreview {
  id: string
  issuedAt: number
}
export interface OwnerManagementAttentionCheck {
  executionStatus: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale' | 'missing'
  outcomeState: 'proposed' | 'needs_clarification' | 'replied' | 'stale' | 'failed' | 'unknown' | 'stopped' | 'missing'
  reason: 'missing_execution' | 'missing_outcome' | 'non_continueable_outcome' | 'missing_receipt' | 'missing_usage' | 'invalid_usage' | 'output_limit'
  requestStartedAt: number | null
  receiptCapturedAt: number | null
  modelId?: string
  outcomeDetail?: string
  providerRequestId?: string
  providerResponseId?: string
  inputTokens: number | null
  outputTokens: number | null
  costSource: 'runtime_reported' | 'unknown' | 'missing'
  costUsd: number | null
}
export interface OwnerManagementDelegationView {
  delegation: OwnerManagementDelegation | null
  state: 'none' | 'active' | 'revoked' | 'expired' | 'stale' | 'exhausted' | 'attention'
  usedRequests: number
  reservedCostMicros: number
  detail: string
  attentionCheck?: OwnerManagementAttentionCheck
  /** Owner模型开销占项目总预算的占比上限用量；只读展示，不代表账单。 */
  ownerModelBudget?: { limitMicros: number; usedMicros: number; settledMicros: number; inFlightMicros: number; remainingMicros: number; ratio: number }
}
