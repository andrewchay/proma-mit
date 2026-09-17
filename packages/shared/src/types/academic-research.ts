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
  | 'topic_proposed'
  | 'topic_selected'
  | 'topic_rejected'
  | 'run_recorded'
  | 'run_status_changed'
  | 'observation_recorded'
  | 'artifact_recorded'
  | 'claim_recorded'
  | 'evidence_linked'
  | 'claim_status_changed'
  | 'manuscript_version_recorded'
  | 'review_finding_recorded'
  | 'reviewer_comment_recorded'
  | 'revision_response_recorded'

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
  | { type: 'topic_proposed'; proposal: TopicProposal }
  | { type: 'topic_selected'; proposalId: string; selectedBy: ApprovalActor; reason?: string }
  | { type: 'topic_rejected'; proposalId: string; reason: string }
  | { type: 'run_recorded'; run: ResearchRun }
  | { type: 'run_status_changed'; runId: string; status: ResearchRunStatus; exitCode?: number; statusReason?: string; logRef?: string }
  | { type: 'observation_recorded'; observation: RunObservation }
  | { type: 'artifact_recorded'; artifact: RunArtifact }
  | { type: 'claim_recorded'; claim: Claim }
  | { type: 'evidence_linked'; link: EvidenceLink }
  | { type: 'claim_status_changed'; claimId: string; status: ClaimStatus; staleReason?: string; verifiedBy?: ApprovalActor; note?: string }
  | { type: 'manuscript_version_recorded'; manuscript: ManuscriptVersion }
  | { type: 'review_finding_recorded'; finding: ReviewFinding }
  | { type: 'reviewer_comment_recorded'; comment: ExternalReviewerComment }
  | { type: 'revision_response_recorded'; response: RevisionResponse }

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

/**
 * 单库检索明细（M7.2）。
 *
 * 记录「这次检索在该库到底做了什么」：请求参数（排序/分页/上限）、
 * 返回命中数与是否截断、以及该库的错误。方案 §12 M2 要求这些必须入日志，
 * 否则「未检出声称不存在」无法被审查。
 */
export interface SearchRunDatabaseResult {
  databaseId: string
  /** 请求的排序方式（未指定则记录 'default'） */
  sort: string
  /** 请求的结果上限（pageSize） */
  pageSize: number
  /** 本次取回的偏移（分页位置） */
  offset: number
  /** 该库报告的命中总数（未提供则 undefined，不猜测） */
  totalCount?: number
  /** 实际返回条数 */
  resultCount: number
  /** 是否存在更多结果被截断 */
  truncated: boolean
  /** 该库的错误（部分失败可见） */
  errors: string[]
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
  /** 每库明细（M7.2）：排序、分页位置、命中数、截断与错误 */
  databaseResults?: SearchRunDatabaseResult[]
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

// ===== 选题候选（M3.2） =====

/**
 * gap 类型：候选选题声称填补的是哪种空白。
 *
 * 方案 §5 要求区分类型，而不是给一个笼统的「新颖性分数」。
 */
export type ResearchGapType =
  | 'unstudied-population'
  | 'unstudied-comparison'
  | 'methodological'
  | 'contradictory-evidence'
  | 'context-transfer'
  | 'conceptual'

/** 查新范围：为排除伪新颖而做过的检索 */
export interface NoveltyCheckScope {
  /** 检索词 */
  queries: string[]
  /** 检索的数据库 */
  databases: string[]
  /** 检索时间 */
  checkedAt: string
  /** 命中的最接近的既有工作（来源 id） */
  closestSourceIds: string[]
  /** 检索局限（如未覆盖商业库/非英文文献） */
  limitations: string[]
}

/**
 * 选题候选。
 *
 * 刻意**不设总分**（方案 §5、§13.3）：可研究性由研究者判断，
 * 系统只保证 gap 类型、证据关联与查新范围被如实记录。
 */
export interface TopicProposal {
  id: string
  projectId: string
  title: string
  /** 候选研究问题 */
  question: string
  gapType: ResearchGapType
  /** 支持该选题存在的证据片段 id */
  supportingEvidenceIds: string[]
  /** 与之矛盾的证据片段 id（反证；不要求非空，但需显式记录检索过） */
  contradictingEvidenceIds: string[]
  /** 论证该 gap 的说明（为什么既有工作不能解决它） */
  gapRationale: string
  /** 反例/替代解释（研究者主动列出，避免只写有利证据） */
  counterarguments: string[]
  noveltyCheck: NoveltyCheckScope
  /** 预计数据源（提示，不代表已接入） */
  plannedDatabases: string[]
  status: 'candidate' | 'selected' | 'rejected'
  createdAt: string
  /** 选定记录（仅 selected；actor 由主进程确定） */
  selection?: {
    selectedBy: ApprovalActor
    selectedAt: string
    reason?: string
  }
}

// ===== 研究运行与分析（M4） =====

/** 运行状态机（提交 → 执行 → 终态） */
export type ResearchRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out'

/** 运行类型：计算任务 / 手工观察登记 / 领域工具验证 */
export type ResearchRunKind = 'compute' | 'manual-observation' | 'tool-validation'

/** 输入清单：运行前冻结，事后不可改（方案 §7 输入 manifest） */
export interface RunInputManifest {
  /** 解释器（compute 必填；须在允许清单内） */
  interpreter?: string
  /** 脚本相对路径（须落在项目目录内） */
  scriptPath?: string
  /** 参数数组（不经过 shell，不做字符串拼接） */
  args?: string[]
  /** 数据/依赖引用（如 DVC 指针、数据集版本），仅作记录 */
  dataRefs?: string[]
  /** 环境声明（依赖文件、随机种子等） */
  environmentNotes?: string
  /** 输入清单摘要（服务层计算，用于事后比对） */
  digest?: string
}

/** 运行资源与费用上限 */
export interface RunBudget {
  /** 墙钟超时（毫秒） */
  timeoutMs: number
  /** 输出保留上限（字节） */
  maxOutputBytes: number
}

/**
 * 研究运行记录。
 *
 * 注意：completed 只表示进程正常结束，**不代表结论成立**（方案 §11.4）。
 */
export interface ResearchRun {
  id: string
  projectId: string
  /** 可选：关联的协议版本（有协议时必须记录） */
  protocolVersion?: number
  kind: ResearchRunKind
  status: ResearchRunStatus
  /** 人类可读标题 */
  title: string
  input: RunInputManifest
  budget: RunBudget
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  /** 失败/超时原因（不保存可能含敏感内容的原始错误正文，只存归一化说明） */
  statusReason?: string
  /** 日志文件相对路径（run-logs/<runId>.log） */
  logRef?: string
  createdAt: string
  /**
   * 外部工具来源（M6）：该运行来自外部工具时填写。
   * 存在时表示这是**外部事实的映射**，本插件未执行也没有其执行权；
   * status 由外部状态归一化得到（未知状态不猜测 completed）。
   */
  externalRef?: {
    tool: string
    toolProjectId?: string
    toolRunId: string
    /** 外部原始状态（便于排查映射偏差） */
    rawStatus?: string
    commitSha?: string
  }
}

/** 手工观察登记（质性/湿实验/现场研究的原始记录入口） */
export interface RunObservation {
  id: string
  projectId: string
  runId: string
  /** 观察内容（访谈摘记、实验现象、现场记录） */
  text: string
  /** 记录人（主进程确定） */
  recordedBy: ApprovalActor
  recordedAt: string
}

/** 运行产物：文件或外部对象引用 */
export interface RunArtifact {
  id: string
  projectId: string
  runId: string
  /** 相对路径或外部引用（file://… / doi:… / dvc:…） */
  ref: string
  /** 内容摘要（本地文件为 sha256；外部引用可为空并标 unverified） */
  digest?: string
  sizeBytes?: number
  /** 校验状态：本地文件已算摘要 = verified；外部引用 = unverified */
  integrity: 'verified' | 'unverified'
  note?: string
  recordedAt: string
}

// ===== 主张与稿件（M5） =====

/** 主张类型：不同类型对证据的要求不同（方案 §4.1 四条方法路径） */
export type ClaimType =
  | 'empirical'
  | 'methodological'
  | 'theoretical'
  | 'limitation'
  | 'clinical-implication'

/**
 * 主张状态。
 *
 * `researcher_verified` 仅表示**某位研究者对该版本的确认**，
 * 不代表期刊认可或客观正确（方案 §6.3）。
 */
export type ClaimStatus =
  | 'draft'
  | 'machine_checked'
  | 'needs_review'
  | 'researcher_verified'
  | 'unsupported'
  | 'contested'
  | 'stale'

/** 证据与主张的关系：支持 / 反对 / 限定适用范围 */
export type EvidenceRelation = 'supports' | 'opposes' | 'qualifies'

/**
 * 主张—证据关联。
 *
 * 必须至少指向一个真实对象：证据片段、产物、或运行记录。
 * 不允许只有自由文本的「依据」。
 */
export interface EvidenceLink {
  id: string
  claimId: string
  relation: EvidenceRelation
  /** 证据片段 id（来源原文片段） */
  evidenceId?: string
  /** 运行产物 id */
  artifactId?: string
  /** 运行记录 id */
  runId?: string
  /** 观察记录 id（质性/现场） */
  observationId?: string
  /** 适用范围/限定说明 */
  note?: string
  createdBy: ApprovalActor
  createdAt: string
}

/** 研究主张：可被单独验证/推翻的陈述 */
export interface Claim {
  id: string
  projectId: string
  /** 主张陈述本身 */
  text: string
  type: ClaimType
  status: ClaimStatus
  /** 适用范围（人群、条件、边界） */
  scope?: string
  /** 主张进入稿件后的所在章节（可选） */
  sectionRef?: string
  createdAt: string
  updatedAt: string
  /** 人工确认记录（仅 researcher_verified） */
  verification?: {
    verifiedBy: ApprovalActor
    verifiedAt: string
    note?: string
  }
  /** 被标记为 stale 的原因（源变化/证据撤回等） */
  staleReason?: string
}

/** 稿件章节 */
export interface ManuscriptSection {
  id: string
  heading: string
  content: string
  /** 该章节引用的主张 id */
  claimIds: string[]
  /** 引用文献（来源 id 或外部标识） */
  citationRefs: string[]
}

/** 稿件版本（每次修改产生新版本，历史保留） */
export interface ManuscriptVersion {
  id: string
  projectId: string
  version: number
  title: string
  sections: ManuscriptSection[]
  /** 变更理由（version > 1 必填） */
  changeReason?: string
  createdBy: ApprovalActor
  createdAt: string
}

// ===== 外部工具集成（M6） =====

/**
 * 外部工具在 Gravitas 中的角色。
 *
 * `descriptor-only`：只登记能力与前置条件，不提供执行路径——
 * 用于尚未接入或需要用户自行安装/授权的工具。**不得**把描述符
 * 当作已集成能力（方案 §7）。
 */
export type ExternalToolRole = 'cli-adapter' | 'descriptor-only'

/** 探测结果 */
export type ExternalToolStatus =
  | 'available'
  | 'not-installed'
  | 'version-mismatch'
  | 'license-not-acknowledged'
  | 'disabled'
  | 'probe-error'

/** 工具登记描述符（不随代码内置任何上游源码或二进制） */
export interface ExternalToolDescriptor {
  id: string
  name: string
  role: ExternalToolRole
  /** 需要探测的可执行文件名（CLI adapter 才有） */
  binary?: string
  /** 探测参数（如 ['--version']） */
  versionArgs?: string[]
  /** 期望版本前缀（可选；不匹配则报 version-mismatch） */
  expectedVersionPrefix?: string
  /** 许可与条款说明（必须由用户确认后才启用） */
  licenseNote: string
  /** 来源仓库/文档链接（供用户自行安装） */
  homepage: string
  /** 该工具能做什么（用于 UI 展示与用户判断） */
  capabilities: string[]
  /** 该工具需要用户自行准备的前置条件 */
  prerequisites: string[]
}

/** 工具启用状态（落盘，不含凭据） */
export interface ExternalToolConfig {
  toolId: string
  enabled: boolean
  /** 用户确认许可的时间（ISO）；缺省表示未确认 */
  licenseAcknowledgedAt?: string
  /** 固定版本（用户填写实际安装版本，便于事后复现） */
  pinnedVersion?: string
}

export interface ExternalToolStatusView {
  descriptor: ExternalToolDescriptor
  config: ExternalToolConfig
  status: ExternalToolStatus
  /** 探测到的版本（available 时） */
  detectedVersion?: string
  /** 说明（如缺失原因、需用户执行什么） */
  detail?: string
}

// ===== 审查与修订（M7.3） =====

/**
 * 审查发现来源。
 *
 * `rule-lint`：确定性规则检查，可复核、可标 error。
 * `llm-suggestion`：模型建议，不可复现，最高只能标 warning，
 * 且必须记录模型与理由。
 */
export type ReviewFindingKind = 'rule-lint' | 'llm-suggestion'

export interface ReviewFindingBasis {
  /** rule-lint：规则名与实测值 */
  rule?: string
  measured?: string
  expected?: string
  /** llm-suggestion：模型标识与理由 */
  model?: string
  rationale?: string
  promptRef?: string
}

export interface ReviewFinding {
  id: string
  kind: ReviewFindingKind
  severity: 'error' | 'warning' | 'info'
  message: string
  location?: string
  basis: ReviewFindingBasis
  createdAt: string
}

/**
 * 外部审稿意见（来自期刊/合作者）。
 *
 * 命名带 External 前缀：旧的论文 pipeline（types/academic.ts）已有
 * 同名的 ReviewerComment（其语义是模型模拟评审的生成意见），两者
 * 形状与含义不同，不能共用一个名字。
 */
export interface ExternalReviewerComment {
  id: string
  projectId: string
  reviewerName: string
  content: string
  targetSection?: string
  severity: 'major' | 'minor' | 'suggestion'
  recordedAt: string
}

export type RevisionResponseStatus = 'addressed' | 'partially-addressed' | 'rejected' | 'pending'

/** 作者对审稿意见的回复（状态为作者声明，不代表审稿人认可） */
export interface RevisionResponse {
  id: string
  projectId: string
  commentId: string
  status: RevisionResponseStatus
  response: string
  manuscriptVersionId?: string
  claimIds: string[]
  respondedBy: ApprovalActor
  respondedAt: string
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
  LIST_TOPICS: 'academic-research:list-topics',
  CREATE_TOPIC: 'academic-research:create-topic',
  SELECT_TOPIC: 'academic-research:select-topic',
  REJECT_TOPIC: 'academic-research:reject-topic',
  LIST_RUNS: 'academic-research:list-runs',
  CREATE_RUN: 'academic-research:create-run',
  CANCEL_RUN: 'academic-research:cancel-run',
  RECORD_OBSERVATION: 'academic-research:record-observation',
  LIST_OBSERVATIONS: 'academic-research:list-observations',
  LIST_ARTIFACTS: 'academic-research:list-artifacts',
  GET_ALLOWED_INTERPRETERS: 'academic-research:get-allowed-interpreters',
  RECONCILE_RUNS: 'academic-research:reconcile-runs',
  READ_RUN_LOG: 'academic-research:read-run-log',
  RECORD_ARTIFACT: 'academic-research:record-artifact',
  IMPORT_DVC_POINTER: 'academic-research:import-dvc-pointer',
  IMPORT_EXTERNAL_RUNS: 'academic-research:import-external-runs',
  LIST_CLAIMS: 'academic-research:list-claims',
  CREATE_CLAIM: 'academic-research:create-claim',
  LINK_EVIDENCE: 'academic-research:link-evidence',
  SET_CLAIM_STATUS: 'academic-research:set-claim-status',
  PROPAGATE_INVALIDATION: 'academic-research:propagate-invalidation',
  LIST_MANUSCRIPTS: 'academic-research:list-manuscripts',
  CREATE_MANUSCRIPT_VERSION: 'academic-research:create-manuscript-version',
  EXPORT_PREFLIGHT: 'academic-research:export-preflight',
  LIST_EXTERNAL_TOOLS: 'academic-research:list-external-tools',
  SET_EXTERNAL_TOOL: 'academic-research:set-external-tool',
  PROBE_EXTERNAL_TOOLS: 'academic-research:probe-external-tools',
  EXPORT_RESEARCH_BUNDLE: 'academic-research:export-research-bundle',
  RECORD_RULE_FINDING: 'academic-research:record-rule-finding',
  RECORD_LLM_FINDING: 'academic-research:record-llm-finding',
  LIST_REVIEW_FINDINGS: 'academic-research:list-review-findings',
  RECORD_REVIEWER_COMMENT: 'academic-research:record-reviewer-comment',
  RESPOND_TO_REVIEWER_COMMENT: 'academic-research:respond-to-reviewer-comment',
  LIST_REVIEWER_COMMENTS: 'academic-research:list-reviewer-comments',
  BUILD_RESPONSE_DRAFT: 'academic-research:build-response-draft',
  MANUSCRIPT_DIFF: 'academic-research:manuscript-diff',
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
