/** 项目外部变化观察：一次扫描的结构化判断结果，只作事实记录，不构成执行授权。 */
export type WebChangeJudgment = 'record_only' | 'attention' | 'decision_required' | 'insufficient_evidence' | 'duplicate'

export type WebChangeDuplicateReason = 'same_source' | 'same_event' | 'no_new_content'

export interface ProjectWebChangeFact {
  title: string
  url: string
  /** 归一化后的来源标识，由服务端计算，不接受模型输入。 */
  sourceId: string
  /** 该来源摘要内容的哈希；用于跨扫描判断"同源是否真有新内容"，不依赖扫描流水保留窗口。 */
  snippetDigest: string | null
  /** 无法确认发布时间时必须为 null，不得用扫描日期顶替。 */
  publishedAt: string | null
  /** 事实必须带原文引用；推断可为空。 */
  quote: string
  isInference: boolean
}

export interface ProjectWebChangeObservation {
  schemaVersion: 1
  id: string
  projectId: string
  runId: string
  createdAt: number
  judgment: WebChangeJudgment
  facts: ProjectWebChangeFact[]
  impact: string | null
  suggestion: string | null
  question: string | null
  uncertainty: string | null
  failureReason: string | null
  relatedObservationIds: string[]
  duplicateOf: string | null
  duplicateReason: WebChangeDuplicateReason | null
  /** 判断所依据的项目上下文快照；目标改版后旧观察不再套用。 */
  binding: {
    goalRevision: number | null
    contextFingerprint: string | null
    topics: string[]
  }
  evaluation: {
    modelId: string | null
    promptVersion: number
    sourcesCount: number
    truncated: boolean
  }
  contentHash: string
}
