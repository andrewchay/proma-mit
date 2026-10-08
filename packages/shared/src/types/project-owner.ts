/** 项目 Owner 的规划元数据；不是任务、执行或授权账本。 */
export interface ProjectOwnerGoalSubject {
  projectId: string
  /** 缺省为项目目标；存在时必须是同项目的真实任务。 */
  taskId?: string
}

export interface ProjectOwnerGoalInput {
  objective: string
  constraints?: string[]
  acceptanceCriteria?: string[]
}

export interface ProjectOwnerGoalBrief extends ProjectOwnerGoalSubject {
  goalVersion: number
  objective: string
  constraints: string[]
  acceptanceCriteria: string[]
}

export interface ProjectOwnerGoalDraft {
  schemaVersion: 1
  revision: number
  state: 'draft'
  actor: 'local-user'
  savedAt: number
  goal: ProjectOwnerGoalBrief
}

export interface SaveProjectOwnerGoalRequest extends ProjectOwnerGoalSubject {
  /** 0 仅用于首次保存；主进程生成下一版本。 */
  expectedRevision: number
  input: ProjectOwnerGoalInput
}

export interface ProjectOwnerGoalSuccess<T> {
  ok: true
  value: T
}

export interface ProjectOwnerGoalFailure {
  ok: false
  error: {
    code: 'conflict' | 'failed'
    message: string
  }
}

/** Electron 会丢失 Error 自定义字段，失败显式编码，不依赖消息字符串判断冲突。 */
export type ProjectOwnerGoalResult<T> = ProjectOwnerGoalSuccess<T> | ProjectOwnerGoalFailure

export interface ProjectOwnerGoalApi {
  getOwnerGoalDraft: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerGoalDraft | null>>
  saveOwnerGoalDraft: (request: SaveProjectOwnerGoalRequest) => Promise<ProjectOwnerGoalResult<ProjectOwnerGoalDraft>>
}

/** 计划内步骤不是权威任务，roleKey仅为岗位能力建议。 */
export interface ProjectOwnerPlanStep {
  key: string
  title: string
  outcome: string
  acceptanceCriteria: string[]
  dependencies: string[]
  roleKey: string
}

export interface ProjectOwnerPlanProposal extends ProjectOwnerGoalSubject {
  goalVersion: number
  mode: 'proposal_only'
  summary: string
  assumptions: string[]
  risks: string[]
  steps: ProjectOwnerPlanStep[]
}

export interface ProjectOwnerRoleAdvice {
  key: string
  name: string
  version: string
  sourceSha256: string
  rulesSha256: string
}

/** 冻结的是规划来源，不是员工实例、执行权限或外部成果证明。 */
export interface ProjectOwnerPlanSources {
  project: { id: string; title: string; description: string }
  task?: { id: string; projectId: string; title: string; description: string }
  roles: ProjectOwnerRoleAdvice[]
}

export interface ProjectOwnerPlanningContext {
  goal: ProjectOwnerGoalDraft
  sources: ProjectOwnerPlanSources
  fingerprint: string
}

export interface ProjectOwnerPlanInput {
  /** 从主进程取得的规划来源指纹；不能把晚到提案绑定到新来源。 */
  expectedContextFingerprint: string
  summary: string
  assumptions: string[]
  risks: string[]
  steps: ProjectOwnerPlanStep[]
  changeReason: string
}

export interface ProjectOwnerPlanDraft extends ProjectOwnerGoalSubject {
  schemaVersion: 1
  revision: number
  planVersion: number
  goalRevision: number
  goalVersion: number
  /** stale由最新目标/来源派生，旧历史本身不被覆盖。 */
  state: 'proposed' | 'confirmed' | 'stale'
  actor: 'local-user'
  /** 当前接口仅允许本机人工记录；尚未实现模型规划调用。 */
  origin: 'manual'
  savedAt: number
  changeReason: string
  contextFingerprint: string
  /** 内容与来源校验值；不构成签名或执行授权。 */
  planFingerprint: string
  sources: ProjectOwnerPlanSources
  proposal: ProjectOwnerPlanProposal
}

export interface ProjectOwnerPlanVersionRequest extends ProjectOwnerGoalSubject {
  expectedGoalRevision: number
  expectedRevision: number
}

export interface SaveProjectOwnerPlanRequest extends ProjectOwnerPlanVersionRequest {
  input: ProjectOwnerPlanInput
}

/** 只保存/确认内容，不收费、不派发；与目标接口分离兼容旧调用方。 */
export interface ProjectOwnerPlanApi {
  getOwnerPlanningContext: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanningContext>>
  getOwnerPlanDraft: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft | null>>
  listOwnerPlanHistory: (subject: ProjectOwnerGoalSubject) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft[]>>
  saveOwnerPlanDraft: (request: SaveProjectOwnerPlanRequest) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft>>
  confirmOwnerPlanDraft: (request: ProjectOwnerPlanVersionRequest) => Promise<ProjectOwnerGoalResult<ProjectOwnerPlanDraft>>
}
