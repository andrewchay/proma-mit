/** 只读项目驾驶观察契约。不是派发命令或自动执行授权。 */
export interface PilotTaskObservation {
  taskId: string
  parentTaskId?: string
  rootTaskId: string
  title: string
  status: string
  updatedAt: number
  state: 'waiting_dependency' | 'awaiting_review' | 'needs_attention' | 'ready' | 'running' | 'done' | 'inactive'
  reason: string
  executionId?: string
  blockerTaskIds: string[]
}

export interface PilotAttention {
  sourceType: 'decision' | 'delivery'
  sourceId: string
  taskId?: string
  sourceVersion: number
  reason: string
}

export interface PilotObservation {
  projectId: string
  projectTitle: string
  chainRevision: number
  fingerprint: string
  observedAt: number
  tasks: PilotTaskObservation[]
  attention: PilotAttention[]
  mode: 'read_only'
}

/** 当前候选只供展示与诊断，不构成执行授权。 */
export interface PilotIntent {
  id: string
  projectId: string
  sourceType: 'task' | 'decision' | 'delivery'
  sourceId: string
  sourceVersion: string
  kind: 'dependency_wait' | 'ready_candidate' | 'review_candidate' | 'attention_candidate'
  status: 'open' | 'stale'
  createdAt: number
}

export interface PilotOverviewSnapshot {
  observation: PilotObservation
  intents: PilotIntent[]
}

/** 项目经理确认前可见的活动授权影响面。 */
export interface PilotGrantIssuePreview {
  projectId: string
  policyRevision: number
  workspaceId: string
  channelId: string
  modelId: string
  executorEmployeeId: string
  reviewerEmployeeId: string
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
  approvalFingerprint: string
}

export interface PilotRuntimeGrant extends Omit<PilotGrantIssuePreview, 'approvalFingerprint'> {
  grantId: string
  state: 'active' | 'paused'
  /** 旧库活动记录可能缺少确认指纹；只能进入保守暂停/人工对账。 */
  approvalFingerprint: string | null
  createdAt: number
}

export interface PilotPolicySummary {
  revision: number
  state: 'paused'
  workspaceId: string
  employeeIds: string[]
  executorEmployeeId?: string
  reviewerEmployeeId?: string
  channelId: string
  modelId: string
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
}

export interface PilotPolicyDraftInput {
  workspaceId: string
  employeeIds: string[]
  executorEmployeeId: string
  reviewerEmployeeId: string
  modelId: string
  channelId: string
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
}

export interface PilotControlSnapshot {
  projectId: string
  policy: PilotPolicySummary | null
  readiness: {
    policyRevision: number | null
    bindingsValid: boolean
    blockers: string[]
  }
  activeGrant: PilotRuntimeGrant | null
  grantStatus: 'none' | 'active' | 'expired' | 'needs_reconcile'
}

export type PilotRunningDisposition = 'finish_current' | 'request_stop'

export interface PilotRunningChoice {
  executionId: string
  disposition: PilotRunningDisposition
}

export interface PilotGrantPauseTarget {
  commandId: string
  executionId: string
  taskId: string
  agentId: string
  sessionId: string
}

export interface PilotGrantPauseImpact {
  grantId: string
  projectId: string
  policyRevision: number
  fingerprint: string
  reservedCommandIds: string[]
  queued: PilotGrantPauseTarget[]
  running: PilotGrantPauseTarget[]
}

export interface PilotGrantPauseResult {
  grantId: string
  cancelledExecutionIds: string[]
  releasedReservationCommandIds: string[]
  runningChoices: PilotRunningChoice[]
  pendingStopExecutionIds: string[]
}
