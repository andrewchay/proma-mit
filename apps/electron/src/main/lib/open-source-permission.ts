/**
 * 开源版权限适配器
 *
 * 为 Electron 开源版提供统一的权限检查接口。
 * 开源版始终返回 admin 权限，保持向后兼容。
 */

import type { AgentRuntimeScope, AgentRuntimeRole } from '@gravitas/shared'

/**
 * 开源版权限检查：始终允许
 *
 * 所有操作都允许，因为开源版是单机应用，用户就是所有者。
 */
export function checkOpenSourcePermission(
  _scope: AgentRuntimeScope,
  _action: string,
  _resource?: string,
): { allowed: boolean; reason?: string } {
  return { allowed: true }
}

/**
 * 开源版角色检查：始终返回 true
 *
 * 开源版用户始终拥有所有角色。
 */
export function hasOpenSourceRole(
  _scope: AgentRuntimeScope,
  _requiredRoles: AgentRuntimeRole[],
): boolean {
  return true
}

/**
 * 开源版工作区权限：始终允许
 */
export function checkOpenSourceWorkspacePermission(
  _scope: AgentRuntimeScope,
  _workspaceSlug: string,
  _action: string,
): { allowed: boolean; reason?: string } {
  return { allowed: true }
}
