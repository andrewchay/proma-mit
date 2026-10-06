/**
 * 学术助手领域类型
 *
 * 从 PAA 的 @paa/shared 迁移，作为学术助手插件（com.gravitas.academic）
 * 的类型契约。纯类型定义，无运行时依赖。
 */

// ===== Stage 2.5 完整性检查 =====

export interface CitationCheckResult {
  id: string
  rawText: string
  isValid: boolean
  issue?: string
  suggestion?: string
}

export interface DataConsistencyIssue {
  id: string
  type: 'number-mismatch' | 'table-error' | 'unit-inconsistent' | 'missing-reference'
  description: string
  location?: string
  severity: 'error' | 'warning'
}

export interface LogicGap {
  id: string
  type: 'missing-premise' | 'weak-inference' | 'untested-assumption' | 'circular-reasoning'
  description: string
  location?: string
  severity: 'major' | 'minor'
}

export interface IntegrityReport {
  paperId: string
  checkedAt: number
  citations: CitationCheckResult[]
  dataIssues: DataConsistencyIssue[]
  logicGaps: LogicGap[]
  aiDisclosure: string
  overallScore: number
  isSubmittable: boolean
}

// ===== Stage 3 同行评审 =====

export interface ReviewerComment {
  id: string
  reviewer: 'editor' | 'expert-1' | 'expert-2' | 'expert-3' | 'devil-advocate'
  reviewerName: string
  category: 'methodology' | 'clarity' | 'significance' | 'originality' | 'structure' | 'language' | 'ethics'
  severity: 'major' | 'minor' | 'suggestion'
  content: string
  suggestion: string
  section?: string
  location?: string
}

export interface PeerReviewReport {
  paperId: string
  generatedAt: number
  overallScore: number
  decision: 'accept' | 'minor-revision' | 'major-revision' | 'reject'
  dimensionScores: {
    originality: number
    methodology: number
    significance: number
    clarity: number
    structure: number
  }
  comments: ReviewerComment[]
  editorSummary: string
  methodologyReview: {
    score: number
    issues: string[]
    strengths: string[]
  }
}

// ===== Stage 4-5 修改追踪 + 发表准备 =====

export type CommentStatus = 'pending' | 'in_progress' | 'resolved' | 'disputed' | 'wontfix'

export interface ReviewerCommentRecord {
  id: string
  reviewerName: string
  content: string
  suggestion: string
  severity: 'major' | 'minor' | 'suggestion'
  category: string
  status: CommentStatus
  targetSection?: string
  response?: string
  diffSnapshot?: string
  recordedAt: number
  resolvedAt?: number
}

export interface RevisionTracking {
  paperId: string
  round: number
  comments: ReviewerCommentRecord[]
  progress: {
    total: number
    resolved: number
    inProgress: number
    pending: number
  }
  updatedAt: number
}

export interface ResponseToReviewersDraft {
  paperId: string
  responses: Array<{
    commentId: string
    reviewerName: string
    originalComment: string
    responseText: string
    isAddressed: boolean
    changesMade?: string
  }>
  completionPercentage: number
}

export interface JournalMatch {
  journalName: string
  publisher: string
  matchScore: number
  impactFactor: string
  acceptanceRate: number
  reviewTime: number
  scopeMatch: string[]
  recommendation: string
}

// ===== 论文项目与五阶段 Pipeline =====

/** 学术五阶段 pipeline 节点 */
export type AcademicStage =
  | 'research'
  | 'write'
  | 'integrity'
  | 'review'
  | 'revise'
  | 'finalize'

export type AcademicStageStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped'

/** 单个阶段在执行链中的状态记录 */
export interface AcademicStageRecord {
  stage: AcademicStage
  status: AcademicStageStatus
  /** 该阶段产出物引用（如完整性报告 id、评审报告 id） */
  artifactRefs: string[]
  startedAt?: number
  completedAt?: number
  /** 阻断原因（status 为 blocked 时必填） */
  blockedReason?: string
}

/**
 * 论文项目
 *
 * 本地持久化的学术工作单元。注意：integrity 阶段不可跳过，
 * 服务端会拒绝把 integrity 标记为 skipped 的请求。
 */
export interface AcademicPaper {
  id: string
  title: string
  abstract?: string
  field?: string
  /** 论文正文（Markdown 或纯文本） */
  content: string
  keywords: string[]
  targetJournal?: string
  stages: AcademicStageRecord[]
  /** 当前所处阶段 */
  currentStage: AcademicStage
  /** 已完成的修订轮次 */
  revisionRound: number
  createdAt: string
  updatedAt: string
}

export interface AcademicPaperSummary {
  id: string
  title: string
  field?: string
  currentStage: AcademicStage
  revisionRound: number
  /** 已完成阶段数 / 总阶段数（integrity 计入） */
  stageProgress: { completed: number; total: number }
  updatedAt: string
}

/** pipeline 推进结果 */
export interface AcademicAdvanceResult {
  paper: AcademicPaper
  /** 本次推进实际执行的阶段 */
  executedStage: AcademicStage
  /** 阶段产出摘要（供 UI 与 Agent 展示） */
  summary: string
  /** 若被阻断，说明原因 */
  blockedReason?: string
}

export const ACADEMIC_IPC_CHANNELS = {
  // 论文项目管理
  /** 获取论文列表 */
  LIST_PAPERS: 'academic:list-papers',
  /** 获取论文详情 */
  GET_PAPER: 'academic:get-paper',
  /** 创建论文 */
  CREATE_PAPER: 'academic:create-paper',
  /** 更新论文 */
  UPDATE_PAPER: 'academic:update-paper',
  /** 删除论文 */
  DELETE_PAPER: 'academic:delete-paper',

  // Pipeline
  /** 推进到下一阶段 */
  ADVANCE_STAGE: 'academic:advance-stage',
  /** 回退到指定阶段 */
  REWIND_STAGE: 'academic:rewind-stage',

  // 阶段产出物
  /** 获取完整性报告 */
  GET_INTEGRITY_REPORT: 'academic:get-integrity-report',
  /** 获取评审报告 */
  GET_PEER_REVIEW_REPORT: 'academic:get-peer-review-report',
  /** 获取修订追踪 */
  GET_REVISION_TRACKING: 'academic:get-revision-tracking',
} as const
