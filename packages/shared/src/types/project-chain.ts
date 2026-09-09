/** 项目决策、交付物和交接的版本化记录。 */
export interface ProjectDecision {
  id: string
  version: number
  title: string
  rationale: string
  evidence: string
  actor: string
  at: number
  /** 未配置 DACI 的旧/低风险记录保持已决定，关键决策须由 approver 确认。 */
  status: 'candidate' | 'decided' | 'superseded'
  daci?: ProjectDecisionDaci
  deadlineAt?: number
  impactTaskIds: string[]
  alternatives: ProjectDecisionAlternative[]
  assumptions: string[]
  sourceRefs: ProjectDecisionSourceRef[]
  supersedes?: { id: string; version: number }
  supersededBy?: { id: string; version: number }
  approvedBy?: string
  approvedAt?: number
  selectedAlternativeId?: string
}
export type ProjectDecisionSourceType =
  | 'document'
  | 'meeting'
  | 'message'
  | 'task'
  | 'url'
  | 'other'
  | 'legacy'
export interface ProjectDecisionSourceRef {
  sourceType: ProjectDecisionSourceType
  /** 权威来源 ID，例如文档、会议、消息或任务 ID。 */
  sourceId: string
  /** 来源内稳定定位，例如 page:3#paragraph:2 或 message:om_xxx。 */
  locator: string
  /** 可选内容校验值；只保存声明值，不自动证明外部内容真实性。 */
  checksum?: string
}
export interface ProjectDecisionDaci {
  driverId: string
  approverId: string
  contributorIds: string[]
  informedIds: string[]
}
export interface ProjectDecisionAlternative {
  id: string
  title: string
  tradeoffs: string
}
export interface ProjectDeliveryResponsibilities {
  ownerId: string
  reviewerId: string
  recipientId: string
}
export interface ProjectDeliverableExecution {
  id: string
  agentId: string
  sessionId: string
  completedAt: number
}
export type ProjectDodVerifier = 'artifact_reference_present' | 'completed_execution'
export interface ProjectDodAutomationRule {
  criterion: string
  verifier: ProjectDodVerifier
}
export interface ProjectDodAutoAcceptancePolicy {
  taskId: string
  enabled: boolean
  riskLevel: 'low'
  rules: ProjectDodAutomationRule[]
}
export interface ProjectDodCheckResult {
  criterion: string
  status: 'passed' | 'failed'
  mode: 'manual' | 'automatic'
  verifier?: ProjectDodVerifier
  evidenceRef: string
  checkedBy: string
  checkedAt: number
}
export interface ProjectDeliverable {
  id: string
  version: number
  taskId: string
  title: string
  content: string
  /** 成果位置或版本引用；只记录引用，不自动读取或验证外部内容。 */
  artifactRef?: string
  /** Agent 交付物精确关联的权威执行记录 ID。 */
  executionId?: string
  /** 保存版本时从权威执行记录冻结，避免后续靠标题或自由文本拼接链路。 */
  execution?: ProjectDeliverableExecution
  criteria: string
  recipient: string
  /** 保存交付版本时冻结的项目与任务 DoD 条目。 */
  definitionOfDone: string[]
  /** 验收人逐项确认的 DoD 条目。 */
  acceptedCriteria?: string[]
  /** 每项 DoD 的人工或确定性自动检查结果。 */
  dodCheckResults?: ProjectDodCheckResult[]
  /** 旧记录可缺失，但缺失时禁止继续流转。 */
  responsibilities?: ProjectDeliveryResponsibilities
  decisions: Array<{ id: string; version: number }>
  status:
    | 'draft'
    | 'submitted'
    | 'accepted'
    | 'handoff_pending'
    | 'handed_off'
    | 'needs_review'
    | 'changes_requested'
  actor: string
  at: number
}
export interface ProjectDependencyHandoff {
  dependencyId: string
  upstreamTaskId: string
  downstreamTaskId: string
  need: string
  providerId: string
  consumerId: string
  dueAt: number
  criteria: string[]
  acceptedCriteria?: string[]
  status: 'planned' | 'offered' | 'accepted' | 'returned'
  offerComment?: string
  receiptComment?: string
  updatedAt: number
}
export interface ProjectChainEvent {
  id: string
  action: ProjectChainCommand['kind'] | 'auto_accept'
  entityId: string
  version: number
  actor: string
  at: number
  comment?: string
  evidence?: string
  changeReason?: string
}
export interface ProjectChain {
  revision: number
  decisions: ProjectDecision[]
  /** 保留首版存储键，语义为通用交付物，兼容此前已有记录。 */
  drafts: ProjectDeliverable[]
  decisionHistory: ProjectDecision[]
  draftHistory: ProjectDeliverable[]
  events: ProjectChainEvent[]
  projectDefinitionOfDone: string[]
  taskDefinitionOfDone: Record<string, string[]>
  taskDodAutoAcceptance: Record<string, ProjectDodAutoAcceptancePolicy>
  dependencyHandoffs: ProjectDependencyHandoff[]
  /** Kanban 服务水平预期，用于识别超龄工作项。 */
  serviceLevelDays: number
}
export type ProjectChainCommand =
  | {
      kind: 'decision'
      decisionId?: string
      title: string
      rationale: string
      evidence: string
      changeReason?: string
      daci?: ProjectDecisionDaci
      deadlineAt?: number
      impactTaskIds?: string[]
      alternatives?: ProjectDecisionAlternative[]
      assumptions?: string[]
      sourceRefs?: ProjectDecisionSourceRef[]
    }
  | {
      kind: 'draft'
      draftId?: string
      changeReason?: string
      taskId: string
      title: string
      content: string
      artifactRef?: string
      executionId?: string
      criteria: string
      recipient: string
      responsibilities?: ProjectDeliveryResponsibilities
      decisionIds: string[]
    }
  | { kind: 'approve_decision'; decisionId: string; comment: string; selectedAlternativeId?: string }
  | { kind: 'set_project_dod'; criteria: string[] }
  | { kind: 'set_task_dod'; taskId: string; criteria: string[] }
  | {
      kind: 'set_task_dod_auto_acceptance'
      taskId: string
      enabled: boolean
      riskLevel: 'low'
      rules: ProjectDodAutomationRule[]
    }
  | { kind: 'set_flow_policy'; serviceLevelDays: number }
  | {
      kind: 'define_dependency_handoff'
      dependencyId: string
      upstreamTaskId: string
      downstreamTaskId: string
      need: string
      providerId: string
      consumerId: string
      dueAt: number
      criteria: string[]
    }
  | {
      kind: 'offer_dependency_handoff' | 'accept_dependency_handoff' | 'return_dependency_handoff'
      dependencyId: string
      comment: string
      completedCriteria?: string[]
    }
  | { kind: 'submit'; draftId: string }
  | {
      kind: 'accept' | 'reject' | 'request_handoff' | 'handoff' | 'reject_handoff'
      draftId: string
      comment: string
      evidence?: string
      completedCriteria?: string[]
    }
export const PROJECT_CHAIN_IPC = {
  GET: 'project-chain:get',
  APPLY: 'project-chain:apply',
} as const
