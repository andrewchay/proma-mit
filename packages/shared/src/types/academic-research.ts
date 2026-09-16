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

/** 研究事件类型（M1 只有项目生命周期；后续里程碑扩展） */
export type ResearchEventType =
  | 'project_created'
  | 'brief_updated'
  | 'status_changed'
  | 'project_archived'

/** 事件负载（按 type 判别） */
export type ResearchEventPayload =
  | { type: 'project_created'; project: ResearchProject }
  | { type: 'brief_updated'; brief: ResearchBrief; changeReason: string }
  | { type: 'status_changed'; from: ResearchProjectStatus; to: ResearchProjectStatus; reason?: string }
  | { type: 'project_archived'; reason?: string }

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

// ===== 输入 =====

export interface CreateResearchProjectInput {
  title: string
  domain: ResearchDomain
  methodPath: ResearchMethodPath
  sensitivity?: ResearchSensitivity
  brief?: ResearchBrief
  workspaceId?: string
}
