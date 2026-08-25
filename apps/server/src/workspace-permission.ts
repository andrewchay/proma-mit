/**
 * 工作区级权限服务
 *
 * 为企业版服务端提供工作区级别的权限控制。
 * 支持角色：owner / editor / viewer
 *
 * 权限矩阵：
 * - owner: 完全控制（修改配置、删除工作区、管理成员）
 * - editor: 执行 Agent 任务、修改配置
 * - viewer: 只读
 */

import type { AgentRuntimeScope } from '@gravitas/shared'

export type WorkspaceRole = 'owner' | 'editor' | 'viewer'

export interface WorkspaceMember {
  userId: string
  workspaceSlug: string
  role: WorkspaceRole
  invitedBy?: string
  joinedAt: number
}

export interface WorkspaceInvitation {
  id: string
  workspaceSlug: string
  invitedBy: string
  invitedUserEmail: string
  role: WorkspaceRole
  expiresAt: number
  status: 'pending' | 'accepted' | 'declined'
}

/**
 * 检查用户是否拥有指定工作区的指定角色
 */
export function hasWorkspaceRole(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
  requiredRole: WorkspaceRole,
  members: WorkspaceMember[],
): boolean {
  // admin 角色自动拥有所有工作区的 owner 权限
  if (scope.roles?.includes('admin')) return true

  const member = members.find((m) => m.userId === scope.userId && m.workspaceSlug === workspaceSlug)
  if (!member) return false

  const roleHierarchy: Record<WorkspaceRole, number> = {
    owner: 3,
    editor: 2,
    viewer: 1,
  }

  return roleHierarchy[member.role] >= roleHierarchy[requiredRole]
}

/**
 * 检查用户是否可以访问工作区（任何角色）
 */
export function canAccessWorkspace(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
  members: WorkspaceMember[],
): boolean {
  if (scope.roles?.includes('admin')) return true
  return members.some((m) => m.userId === scope.userId && m.workspaceSlug === workspaceSlug)
}

/**
 * 检查用户是否可以修改工作区配置
 */
export function canModifyWorkspace(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
  members: WorkspaceMember[],
): boolean {
  return hasWorkspaceRole(scope, workspaceSlug, 'editor', members)
}

/**
 * 检查用户是否可以管理工作区成员
 */
export function canManageMembers(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
  members: WorkspaceMember[],
): boolean {
  return hasWorkspaceRole(scope, workspaceSlug, 'owner', members)
}

/**
 * 检查用户是否可以删除工作区
 */
export function canDeleteWorkspace(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
  members: WorkspaceMember[],
): boolean {
  return hasWorkspaceRole(scope, workspaceSlug, 'owner', members)
}

/**
 * 获取用户在工作区的角色
 */
export function getWorkspaceRole(
  scope: AgentRuntimeScope,
  workspaceSlug: string,
  members: WorkspaceMember[],
): WorkspaceRole | null {
  if (scope.roles?.includes('admin')) return 'owner'

  const member = members.find((m) => m.userId === scope.userId && m.workspaceSlug === workspaceSlug)
  return member?.role ?? null
}
