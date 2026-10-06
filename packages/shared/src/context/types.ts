export type ContextItemKind =
  | 'user_intent'
  | 'task_state'
  | 'file_fact'
  | 'tool_observation'
  | 'decision'
  | 'constraint'
  | 'artifact'
  | 'subtask_result'
  | 'permission_policy'
  | 'summary'

export type ContextVisibility = 'parent' | 'child' | 'model' | 'private'

export type ContextMutability = 'read_only' | 'append_only' | 'write'

export type ContextConfidence = 'high' | 'medium' | 'low' | 'unknown'

export type EvidenceKind =
  | 'file_locator'
  | 'tool_result'
  | 'session_message'
  | 'test_result'
  | 'user_statement'
  | 'agent_artifact'

export interface ContextEvidence {
  kind: EvidenceKind
  sourceId: string
  locator?: string
  checksum?: string
  verified: boolean
}

export interface ContextSource {
  kind: EvidenceKind
  id: string
  sessionId: string
  workspaceId?: string
}

/**
 * 可持久化的最小上下文事实单元。
 *
 * 原文内容始终由 durable ledger 保留；summary 是可替换的派生视图，不能覆盖原文事实。
 */
export interface ContextItem {
  id: string
  kind: ContextItemKind
  version: number
  createdAt: string
  updatedAt: string
  content: string
  summary?: string
  tags: string[]
  visibility: ContextVisibility
  mutability: ContextMutability
  confidence: ContextConfidence
  source: ContextSource
  evidence: ContextEvidence[]
  supersedes?: string
  expiresAt?: string
}
