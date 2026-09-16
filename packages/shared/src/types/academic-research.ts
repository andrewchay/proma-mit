/**
 * 学术研究领域类型（M1）
 *
 * 研究项目是可持续积累的研究工作单元，与旧的"论文项目"
 * （AcademicPaper，见 types/academic.ts）并存：旧类型继续服务
 * 五阶段论文 pipeline，本文件定义方案 v1 §6 的研究领域模型。
 *
 * 标识约定：UUID 是内部连接键；DOI/PMID/arXiv/ISBN 等外部标识
 * 一律带命名空间前缀（doi:、pmid:…），在后续里程碑引入。
 */

// ===== 领域与方法路径 =====

/** 七个首批研究方向（方案 §5） */
export type ResearchDomain =
  | 'audiology'
  | 'medical-humanities'
  | 'statistics'
  | 'ai'
  | 'ontology'
  | 'enterprise-ai'
  | 'data-science'

/** 四条方法路径（方案 §4.1）：不强制所有研究套同一种实验范式 */
export type ResearchMethodPath =
  | 'quantitative'
  | 'qualitative'
  | 'formal'
  | 'mixed-practice'

/** 研究项目主状态（粗粒度；细阶段在后续里程碑建模） */
export type ResearchProjectStatus =
  | 'defining'
  | 'literature'
  | 'designing'
  | 'executing'
  | 'analyzing'
  | 'writing'
  | 'reviewing'
  | 'completed'
  | 'archived'

/** 数据敏感级别（方案 §11.2） */
export type ResearchSensitivity = 'public' | 'internal' | 'sensitive' | 'restricted'

// ===== 实体 =====

/** 研究问题定义（问题定义阶段的产物） */
export interface ResearchBrief {
  /** 研究问题（一句话） */
  question: string
  /** 研究目标与预期贡献 */
  goals: string
  /** 范围边界：包含什么、不包含什么 */
  scope: string
  /** 目标读者/发表去向（可选） */
  audience?: string
  /** 资源、时间、伦理等约束（可选） */
  constraints?: string[]
}

/** 研究项目 */
export interface ResearchProject {
  id: string
  title: string
  domain: ResearchDomain
  methodPath: ResearchMethodPath
  status: ResearchProjectStatus
  brief?: ResearchBrief
  /** 关联的 Agent 工作区（可选；不关联则为独立研究项目） */
  workspaceId?: string
  sensitivity: ResearchSensitivity
  /** 乐观并发控制：每次事件递增 */
  revision: number
  createdAt: string
  updatedAt: string
}

// ===== 事件 =====

/** 研究事件类型（M2 增加文献/检索/筛选；旧版本事件不识别即忽略） */
export type ResearchEventType =
  | 'project_created'
  | 'brief_updated'
  | 'status_changed'
  | 'project_archived'
  | 'source_imported'
  | 'search_recorded'
  | 'screening_recorded'

/** 事件负载（按 type 判别） */
export type ResearchEventPayload =
  | { type: 'project_created'; project: ResearchProject }
  | { type: 'brief_updated'; brief: ResearchBrief; changeReason: string }
  | { type: 'status_changed'; from: ResearchProjectStatus; to: ResearchProjectStatus; reason?: string }
  | { type: 'project_archived'; reason?: string }
  | { type: 'source_imported'; source: Source; origin: 'import' | 'search'; searchRunId?: string }
  | { type: 'search_recorded'; run: SearchRunRecord }
  | { type: 'screening_recorded'; decision: ScreeningDecision }

/** 事件信封：一条业务事务对应一个信封（方案 §10.2） */
export interface ResearchEventEnvelope {
  /** 单调递增的事件序号，从 1 开始 */
  revision: number
  /** 幂等键：调用方生成，重复投递被拒绝 */
  commandId: string
  at: string
  payload: ResearchEventPayload
}

// ===== 错误码 =====

export const RESEARCH_ERROR_CODES = {
  /** 输入校验失败（缺字段、非法枚举等） */
  INVALID_INPUT: 'research/invalid-input',
  /** 状态迁移不合法 */
  INVALID_TRANSITION: 'research/invalid-transition',
  /** 重复 commandId */
  DUPLICATE_COMMAND: 'research/duplicate-command',
  /** 项目不存在 */
  NOT_FOUND: 'research/not-found',
  /** 存储文件损坏（保留原件拒绝读写） */
  STORE_CORRUPTED: 'research/store-corrupted',
  /** 乐观并发冲突（revision 过期） */
  REVISION_CONFLICT: 'research/revision-conflict',
} as const

export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[keyof typeof RESEARCH_ERROR_CODES]

/** 研究领域错误：携带稳定错误码，IPC/UI 按码分流 */
export class ResearchError extends Error {
  readonly code: ResearchErrorCode
  constructor(code: ResearchErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ResearchError'
    this.code = code
  }
}

// ===== 文献来源与检索（M2） =====

/** 来源类型（覆盖无 DOI 的书籍/访谈/档案） */
export type SourceType =
  | 'journal-article'
  | 'preprint'
  | 'book'
  | 'book-chapter'
  | 'thesis'
  | 'webpage'
  | 'interview'
  | 'archive'
  | 'dataset'
  | 'other'

/** 外部标识命名空间：DOI 不是全局主键，只是别名之一 */
export type ExternalIdNamespace = 'doi' | 'pmid' | 'arxiv' | 'isbn' | 'zotero' | 'url'

export interface ExternalId {
  namespace: ExternalIdNamespace
  value: string
}

/** 来源获取等级：区分「只有元数据」「有摘要」「有全文」 */
export type RetrievalStatus = 'metadata-only' | 'abstract-only' | 'full-text'

/** 来源的具体版本（预印本 v1/v2 与正式版分开，不静默合并） */
export interface SourceVersion {
  id: string
  sourceId: string
  versionLabel: string
  externalIds: ExternalId[]
  title: string
  authors: string[]
  year?: number
  venue?: string
  abstract?: string
  retrievalStatus: RetrievalStatus
  localAttachmentPath?: string
  licenseNote?: string
  retrievedAt: string
}

/** 来源 = 作品层；版本挂在上面 */
export interface Source {
  id: string
  projectId: string
  type: SourceType
  versions: SourceVersion[]
  createdAt: string
  updatedAt: string
}

/** 筛选决定（标题摘要轮 / 全文轮） */
export interface ScreeningDecision {
  id: string
  projectId: string
  sourceId: string
  round: 'title-abstract' | 'full-text'
  decision: 'include' | 'exclude' | 'maybe'
  reason: string
  recordedAt: string
}

/** 检索运行记录：查询/覆盖/截断入日志，不以未检出声称不存在 */
export interface SearchRunRecord {
  id: string
  projectId: string
  query: string
  databases: string[]
  startedAt: string
  finishedAt: string
  status: 'completed' | 'partial' | 'error'
  resultCount: number
  importedSourceIds: string[]
  truncated: boolean
  errors: string[]
}

// ===== 旧数据迁移 =====

/** 单篇旧论文的映射评估 */
export interface LegacyPaperMapping {
  paperId: string
  title: string
  action: 'migrate' | 'needs_review' | 'unreadable'
  target: 'ResearchProject + ManuscriptVersion'
  missing: string[]
  legacyArtifacts: Array<{ kind: string; exists: boolean }>
}

export interface MigrationDryRunReport {
  papersPath: string
  exists: boolean
  readable: boolean
  totalPapers: number
  mappings: LegacyPaperMapping[]
  warnings: string[]
}

// ===== IPC 通道 =====

export const ACADEMIC_RESEARCH_IPC_CHANNELS = {
  LIST_PROJECTS: 'academic-research:list-projects',
  GET_PROJECT: 'academic-research:get-project',
  CREATE_PROJECT: 'academic-research:create-project',
  UPDATE_BRIEF: 'academic-research:update-brief',
  CHANGE_STATUS: 'academic-research:change-status',
  ARCHIVE_PROJECT: 'academic-research:archive-project',
  MIGRATION_DRY_RUN: 'academic-research:migration-dry-run',
  LIST_SOURCES: 'academic-research:list-sources',
  IMPORT_BIBLIOGRAPHY: 'academic-research:import-bibliography',
  SEARCH_SOURCES: 'academic-research:search-sources',
  LIST_SEARCH_RUNS: 'academic-research:list-search-runs',
  DEDUP_CANDIDATES: 'academic-research:dedup-candidates',
  RECORD_SCREENING: 'academic-research:record-screening',
  LIST_SCREENING: 'academic-research:list-screening',
} as const

// ===== 输入 =====

export interface CreateResearchProjectInput {
  title: string
  domain: ResearchDomain
  methodPath: ResearchMethodPath
  sensitivity?: ResearchSensitivity
  brief?: ResearchBrief
  workspaceId?: string
}
