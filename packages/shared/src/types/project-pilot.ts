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
