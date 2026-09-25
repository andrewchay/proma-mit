/**
 * 研发任务委派与人工 Review 共享类型（M1 契约）。
 *
 * 边界：
 * - developmentScope 是任务级执行范围声明，不是对任意路径的授权；
 * - 快照（DevelopmentSnapshot）是冻结的内容版本，Review / 应用只针对快照，
 *   不针对仍在变化的 worktree 工作目录；
 * - 验证证据（DevelopmentValidation）与 reported 结果在 M3 补充，此处不预置。
 */

/** 研发任务执行范围：全部路径均为仓库相对路径（POSIX 分隔符）。 */
export interface DevelopmentTaskScope {
  /** 执行工作区 ID；必须是绑定本地 Git 仓库的 Agent 工作区 */
  workspaceId: string
  /** 目标文件（用户希望修改的定位），必须落在 allowedPaths 内 */
  targetPaths: string[]
  /** 允许修改范围（含目标、相邻测试、指定文档） */
  allowedPaths: string[]
  /** 人工验收人：身份目录中已启用的非 Agent 用户 ID */
  reviewerId?: string
  /** 关联的真实已决策事项 ID（交付版本冻结其版本号） */
  decisionIds?: string[]
  /** 验证命令（M3 使用；仅作为授权候选，执行仍走审批链路） */
  verificationCommands?: string[]
}

/** 单文件冻结变更。old/new 内容以快照目录内只读文件保存，此处只保存指纹。 */
export interface DevelopmentSnapshotFile {
  /** 仓库相对路径 */
  path: string
  changeType: 'add' | 'modify' | 'delete'
  /** 基线内容 sha256；新增文件为 null */
  oldSha256: string | null
  /** 当前内容 sha256；删除文件为 null */
  newSha256: string | null
  /** 当前内容字节数；删除文件为 0 */
  newBytes: number
}

/** 冻结交付快照清单（内容文件存放在会话私有目录，本结构可序列化校验）。 */
export interface DevelopmentSnapshot {
  id: string
  executionId: string
  workspaceId: string
  /** worktree 创建时的基线提交 */
  baseCommit: string
  /** 整体内容指纹：覆盖 files 全部条目的 hash 链 */
  contentHash: string
  files: DevelopmentSnapshotFile[]
  createdAt: number
}

// ===== M2：Review 查询与委派入口 =====

/** Review 页展示的交付版本（ProjectDeliverable 的可序列化投影）。 */
export interface TaskReviewDelivery {
  id: string
  version: number
  status: string
  title: string
  content: string
  artifactRef?: string
  executionId?: string
  responsibilities?: { ownerId: string; reviewerId: string; recipientId: string }
  dodCheckResults?: Array<{ criterion: string; status: string; mode?: string; checkedBy?: string }>
  acceptedCriteria?: string[]
  createdAt: number
  actor?: string
}

/** 单个任务的 Review 汇总：任务状态、范围、执行记录、交付版本与可选决策。 */
export interface TaskReviewSummary {
  taskId: string
  projectId: string
  title: string
  status: string
  completionNotes?: string
  scope: DevelopmentTaskScope | null
  executions: import('./work-module').AgentExecutionResult[]
  deliveries: TaskReviewDelivery[]
  decidedDecisions: Array<{ id: string; title: string; version: number }>
  /** 当前生效验收人（scope.reviewerId 或 local-user） */
  reviewerId: string
  /** 各已完成执行的冻结快照文件清单（无快照的执行不含在内）。 */
  snapshots: Array<{ executionId: string; baseCommit: string; contentHash: string; files: DevelopmentSnapshotFile[] }>
}

/** 单文件冻结内容（Review 页 DiffView 输入）。 */
export interface DevelopmentSnapshotDiff {
  path: string
  changeType: 'add' | 'modify' | 'delete'
  oldContent: string | null
  newContent: string | null
  truncated: boolean
}

/** 文件委派准备输入：新建任务或关联已有任务（不复制任务）。 */
export interface PrepareFileDelegationInput {
  projectId: string
  workspaceId: string
  employeeId: string
  targetPaths: string[]
  allowedPaths: string[]
  decisionIds: string[]
  verificationCommands?: string[]
  /** 默认 local-user；其他人类验收人需在身份目录启用 */
  reviewerId?: string
  /** 关联模式：提供则不新建任务 */
  existingTaskId?: string
  /** 新建模式必填 */
  newTask?: { title: string; description?: string }
  /** 任务已有其他负责人时必须显式确认改派 */
  confirmHumanReassign?: boolean
}
