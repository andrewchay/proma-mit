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
  | 'evidence_extracted'
  | 'protocol_created'
  | 'protocol_approved'
  | 'protocol_revised'

/** 事件负载（按 type 判别） */
export type ResearchEventPayload =
  | { type: 'project_created'; project: ResearchProject }
  | { type: 'brief_updated'; brief: ResearchBrief; changeReason: string }
  | { type: 'status_changed'; from: ResearchProjectStatus; to: ResearchProjectStatus; reason?: string }
  | { type: 'project_archived'; reason?: string }
  | { type: 'source_imported'; source: Source; origin: 'import' | 'search'; searchRunId?: string }
  | { type: 'search_recorded'; run: SearchRunRecord }
  | { type: 'screening_recorded'; decision: ScreeningDecision }
  | { type: 'evidence_extracted'; evidence: EvidenceExcerpt }
  | { type: 'protocol_created'; protocol: ResearchProtocol }
  | { type: 'protocol_approved'; protocolId: string; version: number; approvedBy: ApprovalActor; checklist: string[]; note?: string }
  | { type: 'protocol_revised'; protocol: ResearchProtocol; supersedesVersion: number; changeReason: string }

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
export type ExternalIdNamespace = 'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'isbn' | 'zotero' | 'url'

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

// ===== 证据抽取（M2 第二批） =====

/** 证据定位器：能回到原文的位置；无定位器的引语不得进入台账 */
export type EvidenceLocator =
  | { kind: 'pdf-page'; page: number; anchor?: string }
  | { kind: 'page'; page: number }
  | { kind: 'section'; label: string }
  | { kind: 'timestamp'; startSeconds: number; endSeconds?: number }
  | { kind: 'url'; url: string; anchor?: string }
  | { kind: 'table'; tableId: string; row?: string }

/**
 * 证据片段：从某来源版本的原文中抽取的引语/事实。
 *
 * 只有原文片段 + 定位器才构成证据；模型生成的摘要不是证据。
 */
export interface EvidenceExcerpt {
  id: string
  projectId: string
  sourceId: string
  sourceVersionId: string
  /** 原文片段（逐字或明确标注的翻译/转写） */
  text: string
  locator: EvidenceLocator
  /** 研究者备注（为什么重要） */
  note?: string
  /** 提取方式：manual / agent-suggested（agent 建议需人工确认） */
  extractionMode: 'manual' | 'agent-suggested'
  createdAt: string
}

// ===== 研究协议（M3） =====

/**
 * 审批 actor。
 *
 * 由主进程确定（当前固定本地用户），**绝不接受渲染层或模型传入**——
 * 否则模型可以把自己批准为研究者（方案 §11.1 操作批准门禁）。
 */
export interface ApprovalActor {
  /** 固定来源：local-user / system:<verifier> 等 */
  id: string
  /** 显示名（本地用户为「本机用户」） */
  displayName: string
  /** 该 actor 是否由主进程注入（渲染层传入一律视为不可信） */
  trusted: boolean
}

/** 协议状态：草稿 → 已批准；修订产生新版本（旧批准不沿用） */
export type ProtocolStatus = 'draft' | 'approved' | 'superseded'

/** 研究协议的一个版本 */
export interface ResearchProtocol {
  id: string
  projectId: string
  /** 版本号，从 1 开始单调递增 */
  version: number
  status: ProtocolStatus
  /** 方法路径（须与项目领域匹配） */
  methodPath: ResearchMethodPath
  /** 按领域 profile 的字段填写（键为 ProfileField.key） */
  fields: Record<string, string>
  /** 人工确认已阅读的检查项 id（批准时须覆盖全部启用检查项） */
  acknowledgedChecks: string[]
  /** 伦理/数据依据（人体数据采集必需） */
  ethicsBasis?: string
  createdAt: string
  updatedAt: string
  /** 批准记录（仅 approved 时存在） */
  approval?: {
    approvedBy: ApprovalActor
    approvedAt: string
    note?: string
  }
  /** 被哪个版本取代（修订后旧版本标记 superseded） */
  supersededByVersion?: number
  /** 修订理由（版本 > 1 时必填） */
  changeReason?: string
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
  LIST_EVIDENCE: 'academic-research:list-evidence',
  EXTRACT_EVIDENCE: 'academic-research:extract-evidence',
  GET_ZOTERO_CONFIG: 'academic-research:get-zotero-config',
  SAVE_ZOTERO_CONFIG: 'academic-research:save-zotero-config',
  IMPORT_FROM_ZOTERO: 'academic-research:import-from-zotero',
  LIST_PROTOCOLS: 'academic-research:list-protocols',
  CREATE_PROTOCOL: 'academic-research:create-protocol',
  APPROVE_PROTOCOL: 'academic-research:approve-protocol',
  REVISE_PROTOCOL: 'academic-research:revise-protocol',
  GET_DOMAIN_PROFILE: 'academic-research:get-domain-profile',
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
