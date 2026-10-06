/**
 * 研发任务范围与预检服务（W01）。
 *
 * 职责：把「文件 → 任务」的委派意图收敛为显式、可校验的执行范围。
 * 边界：
 * - 本服务不创建会话、不派发执行、不写文件；只做范围声明与校验；
 * - 路径一律是仓库相对路径，主进程从工作区解析绝对目录，不信任客户端传入 cwd；
 * - 拒绝不等于静默过滤：范围外文件在派发前阻塞，而不是执行后丢弃。
 */

import type { DevelopmentTaskScope, AgentWorkspace } from '@gravitas/shared'
import type { Task } from './project-types'
import { getTask, updateTask } from './project-sqlite-store'

/** 归一化后的研发范围：路径已清洗，reviewerId / decisionIds 已去重 */
export type NormalizedDevelopmentScope = Readonly<{
  workspaceId: string
  targetPaths: string[]
  allowedPaths: string[]
  reviewerId?: string
  decisionIds?: string[]
  verificationCommands?: string[]
}>

/** 受保护路径：默认禁止纳入允许范围；确需修改走另一次显式范围确认（M2 入口） */
const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /^\.git(\/|$)/,
  /^\.env(\..*)?$|^\.env$/i,
  /^AGENTS\.md$/,
  /^\.context(\/|$)/,
  /^(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml)$/,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_rsa[^/]*$/i,
  /(^|\/)credentials?\.(json|txt)$/i,
  /(^|\/)secrets?(\/|$)/i,
]

export function isProtectedDevelopmentPath(path: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * 清洗单条仓库相对路径。拒绝：绝对路径、`..`、NUL、反斜杠、空段、首尾斜杠、
 * 点结尾段、Windows 盘符。不做文件系统访问（symlink 检查在快照／应用阶段做 realpath）。
 */
export function normalizeRepoRelativePath(raw: string): string {
  if (typeof raw !== 'string') throw new Error('路径必须是字符串')
  const value = raw.trim()
  if (!value) throw new Error('路径不能为空')
  if (value.includes('\0')) throw new Error(`路径包含非法字符：${JSON.stringify(raw)}`)
  if (value.includes('\\')) throw new Error(`路径必须使用 POSIX 分隔符，拒绝反斜杠：${raw}`)
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error(`拒绝绝对路径：${raw}`)
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`路径段不能为空、「.」或「..」：${raw}`)
  }
  return segments.join('/')
}

/** 判断路径是否落在某个允许前缀之内（按路径段匹配，不做字符串前缀误判） */
export function pathWithinAllowed(path: string, allowedPaths: readonly string[]): boolean {
  const segments = path.split('/')
  return allowedPaths.some((allowed) => {
    const allowedSegments = allowed.split('/')
    if (allowedSegments.length > segments.length) return false
    return allowedSegments.every((segment, index) => segment === segments[index])
  })
}

/** 校验并归一化范围声明；不访问文件系统，只做结构级契约校验（T01/T03/T04 的范围部分）。 */
export function validateDevelopmentScope(
  scope: DevelopmentTaskScope,
  facts: { getWorkspace(id: string): AgentWorkspace | undefined },
): NormalizedDevelopmentScope {
  if (!scope || typeof scope !== 'object') throw new Error('缺少研发执行范围')
  const workspace = facts.getWorkspace(scope.workspaceId)
  if (!workspace) throw new Error('执行工作区不存在')
  if (!workspace.rootPath) throw new Error('研发执行工作区必须绑定本地 Git 仓库')

  const targetPaths = [...new Set((scope.targetPaths ?? []).map(normalizeRepoRelativePath))]
  if (!targetPaths.length) throw new Error('研发任务至少需要一个目标文件')
  const allowedPaths = [...new Set((scope.allowedPaths ?? []).map(normalizeRepoRelativePath))]
  if (!allowedPaths.length) throw new Error('研发任务至少需要一个允许修改范围')

  const outside = targetPaths.filter((path) => !pathWithinAllowed(path, allowedPaths))
  if (outside.length) throw new Error(`目标文件不在允许修改范围内：${outside.join('、')}`)

  const protectedTargets = targetPaths.filter(isProtectedDevelopmentPath)
  if (protectedTargets.length) throw new Error(`目标文件属于受保护路径，首版不支持：${protectedTargets.join('、')}`)
  const protectedAllowed = allowedPaths.filter(isProtectedDevelopmentPath)
  if (protectedAllowed.length) throw new Error(`允许范围包含受保护路径，首版不支持：${protectedAllowed.join('、')}`)

  const reviewerId = scope.reviewerId?.trim() || undefined
  if (reviewerId && reviewerId.startsWith('agent-')) {
    throw new Error('人工验收人不能是 AI 员工')
  }
  const decisionIds = scope.decisionIds?.length
    ? [...new Set(scope.decisionIds.map((id) => id.trim()).filter(Boolean))]
    : undefined
  if (scope.decisionIds?.length && !decisionIds?.length) throw new Error('关联决策 ID 无效')
  const verificationCommands = scope.verificationCommands?.length
    ? [...new Set(scope.verificationCommands.map((command) => command.trim()).filter(Boolean))]
    : undefined

  return {
    workspaceId: scope.workspaceId,
    targetPaths,
    allowedPaths,
    ...(reviewerId ? { reviewerId } : {}),
    ...(decisionIds?.length ? { decisionIds } : {}),
    ...(verificationCommands?.length ? { verificationCommands } : {}),
  }
}

/**
 * 为已有任务设置研发范围（文件委派关联）。
 * - 任务必须存在；已完成任务不允许再改范围；
 * - 任务已有人类负责人时必须显式确认改派意图，避免静默抢走用户任务（T02）；
 * - 不创建第二个任务：文件委派要么新建（走 createTask），要么关联本任务。
 */
export function setTaskDevelopmentScope(
  taskId: string,
  scope: DevelopmentTaskScope,
  options: { confirmHumanReassign?: boolean } = {},
  facts: { getWorkspace(id: string): AgentWorkspace | undefined },
): Task {
  const task = getTask(taskId)
  if (!task) throw new Error('任务不存在')
  if (task.completedAt) throw new Error('任务已完成，不能修改执行范围')

  const normalized = validateDevelopmentScope(scope, facts)
  const existingWorkspace = task.developmentScope?.workspaceId
  if (existingWorkspace && existingWorkspace !== normalized.workspaceId) {
    throw new Error('任务已绑定其他执行工作区，请新建任务而不是换绑仓库')
  }
  const isHumanAssignee = Boolean(task.assignee?.userId) && !task.assignee!.userId.startsWith('agent-')
  if (isHumanAssignee && !options.confirmHumanReassign) {
    throw new Error(`任务当前负责人是「${task.assignee!.displayName ?? task.assignee!.userId}」，委派给 AI 员工需要显式确认改派`)
  }

  return updateTask(taskId, { developmentScope: normalized })!
}

/**
 * 派发前预检：任务具备研发执行条件（范围、负责人、工作区一致性）。
 * 返回归一化范围；任何不满足都抛错，由调用方决定如何呈现卡点。
 * 仓库脏检查仍由 worktree 创建时执行（既有链路），此处不重复。
 */
export function resolveDevelopmentDispatchScope(
  task: Task,
  facts: { getWorkspace(id: string): AgentWorkspace | undefined },
): NormalizedDevelopmentScope {
  if (!task.developmentScope) throw new Error('任务未配置研发执行范围，不能按研发链路派发')
  const scope = validateDevelopmentScope(task.developmentScope, facts)
  if (task.workspaceId && task.workspaceId !== scope.workspaceId) {
    throw new Error('任务执行工作区与研发范围不一致，请修正任务配置')
  }
  return scope
}
