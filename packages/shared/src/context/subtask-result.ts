import type { ContextConfidence, ContextEvidence } from './types'

export type SubtaskStatus = 'completed' | 'partial' | 'blocked' | 'failed'

export type SubtaskArtifactKind =
  | 'file_finding'
  | 'plan'
  | 'review_finding'
  | 'research_note'
  | 'test_report'

export interface SubtaskClaim {
  statement: string
  confidence: Exclude<ContextConfidence, 'unknown'>
  evidence: ContextEvidence[]
  verified: boolean
}

export interface SubtaskArtifact {
  kind: SubtaskArtifactKind
  title: string
  content: string
  evidence: ContextEvidence[]
}

/** 子 Agent 返回给父任务的结构化、可追溯产物；不等同于完整 child transcript。 */
export interface SubtaskResult {
  protocolVersion: 1
  taskId: string
  status: SubtaskStatus
  summary: string
  claims: SubtaskClaim[]
  artifacts: SubtaskArtifact[]
  unverified: string[]
  recommendedNextSteps: string[]
}
