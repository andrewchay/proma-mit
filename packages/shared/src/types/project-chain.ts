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
  approvedBy?: string
  approvedAt?: number
  selectedAlternativeId?: string
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
  criteria: string
  recipient: string
  /** 保存交付版本时冻结的项目与任务 DoD 条目。 */
  definitionOfDone: string[]
  /** 验收人逐项确认的 DoD 条目。 */
  acceptedCriteria?: string[]
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
  status: 'planned' | 'offered' | 'accepted' | 'returned'
  offerComment?: string
  receiptComment?: string
  updatedAt: number
}
export interface ProjectChainEvent {
  id: string
  action: ProjectChainCommand['kind']
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
  dependencyHandoffs: ProjectDependencyHandoff[]
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
