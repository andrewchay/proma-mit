/** 技术验证DTO：不替代业务验收，也不赋予模型声明任何信任。 */
export interface VerificationSubject {
  workspaceId: string
  sessionId: string
  /** 本次调用身份，由主进程提供；不能用标题推断。 */
  runId: string
  agentGoalId: string
  /** 业务任务身份必须三项同时存在；独立AgentGoal可全部省略。 */
  projectId?: string
  taskId?: string
  executionId?: string
}

/** 对最新产物的技术引用；复用已有研发快照，不新建内容存储。 */
export interface VerificationArtifactRevision {
  version: 1
  artifactId: string
  subject: VerificationSubject
  baseRevision: string
  contentHash: string
  scopeHash: string
  capturedAt: number
  /** 主进程解析的私有证据引用，不应直接当作任意本地路径读取。 */
  evidenceRef: string
}

export interface VerificationVerifier {
  id: string
  version: string
  configHash: string
  kind: 'test' | 'command'
}

export type VerificationResult = 'passed' | 'failed' | 'unknown' | 'skipped'

/**
 * 一次验证运行的传输契约。
 * source是来源类别，不是鉴权证明。读取方仍须回读权威运行记录、配置和最新产物。
 */
export interface VerificationReceipt {
  version: 1
  receiptId: string
  subject: VerificationSubject
  criteriaId: string
  verifier: VerificationVerifier
  artifact: VerificationArtifactRevision
  toolCallId: string
  startedAt: number
  finishedAt: number
  exitCode: number | null
  result: VerificationResult
  /** test的passed必须>0；command可为null。 */
  checksCollected: number | null
  evidenceRef: string
  source: 'main-process'
}

export interface VerificationParseOptions {
  /** 明确注入时钟，便于确定性测试；非法时钟拒绝解析。 */
  now: number
  expectedSubject: VerificationSubject
}

export type VerificationParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] }
