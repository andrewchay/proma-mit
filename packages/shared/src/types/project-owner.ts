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
