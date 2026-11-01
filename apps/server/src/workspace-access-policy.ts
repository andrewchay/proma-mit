/**
 * 工作区集中授权模型（企业共享工作区的唯一判定入口）。
 *
 * 现状：成员登记只对「已发布成果」生效，`sharedAccessEnabled` 恒为 false，登记不授予
 * 工作区或 Runtime 权限。本模块把「谁能对工作区做什么」抽成一张显式判定表，供后续
 * 工作区读写、Runtime 启动、成员管理等入口统一调用，避免各入口各写一套 if。
 *
 * 边界：
 * - 只做判定，不做身份认证，也不查询数据库；调用方必须传入已认证身份与已读取的成员记录。
 * - 默认失败关闭：未知动作、缺失记录、租户/工作区不匹配一律拒绝。
 * - 共享工作区访问由开关控制；开关默认关闭，开启后也只放行表内明确列出的动作。
 * - 「已发布成果读取」不走工作区权限：发布记录自带成员校验与版本核对。
 */

export type WorkspaceMemberRole = 'owner' | 'editor' | 'viewer'

/** 需要集中授权的动作。新增动作必须同时在判定表里写明允许的角色。 */
export type WorkspaceAccessAction =
  | 'read_workspace'
  | 'write_workspace'
  | 'run_runtime'
  | 'manage_members'
  | 'read_published_artifact'

export interface WorkspaceMembershipRecord {
  tenantId: string
  workspaceSlug: string
  userId: string
  role: Exclude<WorkspaceMemberRole, 'owner'>
}

export interface WorkspaceAccessRequest {
  /** 已认证身份所在租户与目标工作区。 */
  tenantId: string
  workspaceSlug: string
  actorUserId: string
  /** 工作区所有者（由工作区记录自身的 user_id 决定，不来自成员表）。 */
  ownerUserId: string
  /** 已读取的成员记录；非成员传 undefined。 */
  membership?: WorkspaceMembershipRecord | null
  action: WorkspaceAccessAction
  /** 共享工作区访问开关；默认关闭。 */
  sharedAccessEnabled: boolean
}

export interface WorkspaceAccessDecision {
  allowed: boolean
  /** 稳定原因码，便于审计与界面提示；不随文案调整而变化。 */
  reason:
    | 'owner'
    | 'published_artifact_member'
    | 'shared_workspace_granted'
    | 'shared_workspace_disabled'
    | 'not_a_member'
    | 'membership_scope_mismatch'
    | 'role_insufficient'
    | 'unknown_action'
  role: WorkspaceMemberRole
}

const SHARED_WORKSPACE_ROLES: Record<Exclude<WorkspaceAccessAction, 'manage_members' | 'read_published_artifact'>, WorkspaceMemberRole[]> = {
  read_workspace: ['editor', 'viewer'],
  write_workspace: ['editor'],
  run_runtime: ['editor'],
}

/** 判定一个动作是否允许；任何信息缺失或越界都拒绝。 */
export function decideWorkspaceAccess(request: WorkspaceAccessRequest): WorkspaceAccessDecision {
  const isOwner = Boolean(request.ownerUserId) && request.actorUserId === request.ownerUserId
  if (isOwner) {
    if (!isKnownAction(request.action)) return { allowed: false, reason: 'unknown_action', role: 'owner' }
    return { allowed: true, reason: 'owner', role: 'owner' }
  }
  if (!isKnownAction(request.action)) return { allowed: false, reason: 'unknown_action', role: 'viewer' }

  const membership = request.membership
  if (!membership || membership.userId !== request.actorUserId || !membership.tenantId || !membership.workspaceSlug) {
    return { allowed: false, reason: 'not_a_member', role: 'viewer' }
  }
  if (membership.tenantId !== request.tenantId || membership.workspaceSlug !== request.workspaceSlug) {
    return { allowed: false, reason: 'membership_scope_mismatch', role: membership.role }
  }
  // 成员管理只属于所有者，不看角色高低。
  if (request.action === 'manage_members') return { allowed: false, reason: 'role_insufficient', role: membership.role }
  if (request.action === 'read_published_artifact') {
    return { allowed: true, reason: 'published_artifact_member', role: membership.role }
  }

  const allowedRoles = SHARED_WORKSPACE_ROLES[request.action]
  if (!allowedRoles.includes(membership.role)) return { allowed: false, reason: 'role_insufficient', role: membership.role }
  if (!request.sharedAccessEnabled) return { allowed: false, reason: 'shared_workspace_disabled', role: membership.role }
  return { allowed: true, reason: 'shared_workspace_granted', role: membership.role }
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<WorkspaceAccessAction>([
  'read_workspace',
  'write_workspace',
  'run_runtime',
  'manage_members',
  'read_published_artifact',
])

function isKnownAction(action: string): action is WorkspaceAccessAction {
  return KNOWN_ACTIONS.has(action)
}

export interface SharedWorkspaceAccessStartupInput {
  sharedAccessEnabled: boolean
  authMode: string
  /**
   * 判定是否已接进工作区读写与 Runtime 启动。
   *
   * 当前没有入口调用判定函数，因此部署时必须是 false；等到 S1/S3/S4 落地后由调用方传入真实状态。
   */
  workspaceReadEnforcementWired: boolean
}

/**
 * 共享工作区访问的启动校验。
 *
 * 开关一旦打开，成员接口与界面就会对外声明"共享工作区可用"。如果判定还没有接进
 * 工作区读写与 Runtime，这条承诺是空的，甚至比关闭更危险（用户以为权限已生效）。
 * 因此这里失败关闭：没接强制点就不允许打开开关。
 */
export function assertSharedWorkspaceAccessStartupPolicy(input: SharedWorkspaceAccessStartupInput): void {
  if (!input.sharedAccessEnabled) return
  if (!input.workspaceReadEnforcementWired) {
    throw new Error('共享工作区访问尚未接入工作区读写与 Runtime 判定，打开 GRAVITAS_SHARED_WORKSPACE_ACCESS 会对外承诺未强制的权限；请保持关闭')
  }
  if (input.authMode === 'none') {
    throw new Error('共享工作区访问要求已配置身份认证；无鉴权模式只允许本机开发')
  }
}

/**
 * 共享工作区访问开关。
 *
 * 默认关闭：现有成员登记只对已发布成果生效，打开开关等于扩大授权面，
 * 必须显式设置环境变量并经过部署评审，不能随默认值漂移。
 */
export function isSharedWorkspaceAccessEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GRAVITAS_SHARED_WORKSPACE_ACCESS === '1'
}
