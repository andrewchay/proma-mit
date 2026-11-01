/**
 * 共享工作区元数据只读（集中授权的第一个真实读路径）。
 *
 * 只回答"这个工作区存在、属于谁、我能不能看"，**不返回 cwd、MCP 配置或任何凭证**。
 * 是否放行完全由 decideWorkspaceAccess 决定：开关默认关闭，所以当前部署里成员会被明确
 * 拒绝并给出原因码，而不是悄悄返回 404。
 *
 * 依赖以接口注入，便于用桩做隔离测试（真实 Postgres 版在 e2e 覆盖）。
 */

import type { AgentRuntimeScope } from '@gravitas/shared'
import { decideWorkspaceAccess, isSharedWorkspaceAccessEnabled } from './workspace-access-policy.ts'

export interface SharedWorkspaceMetadata {
  ownerUserId: string
  workspaceSlug: string
  /** 当前身份在该工作区里的角色：owner / editor / viewer。 */
  viewerRole: 'owner' | 'editor' | 'viewer'
}

export interface SharedWorkspaceReadDeps {
  /** 只读存在性与所有者；不得返回 cwd 或 MCP 配置。 */
  getOwnedWorkspace: (ownerUserId: string, workspaceSlug: string) => Promise<{ ownerUserId: string; workspaceSlug: string } | undefined>
  /** 当前用户作为成员的角色；非成员返回 undefined。 */
  getMemberRole: (ownerUserId: string, workspaceSlug: string, memberUserId: string) => Promise<'editor' | 'viewer' | undefined>
  sharedAccessEnabled: boolean
}

export type SharedWorkspaceReadResult =
  | { ok: true; value: SharedWorkspaceMetadata }
  | { ok: false; status: 403 | 404; reason: string; error: string }

/**
 * 读取共享工作区元数据。
 *
 * 顺序刻意如此：先判存在性（不存在就是 404，不泄露"别人有没有这个工作区"之外的判断），
 * 再走集中授权；授权失败返回 403 并带稳定原因码，便于审计与前端提示。
 */
export async function readSharedWorkspaceMetadata(
  scope: AgentRuntimeScope,
  ownerUserId: string,
  workspaceSlug: string,
  deps: SharedWorkspaceReadDeps,
): Promise<SharedWorkspaceReadResult> {
  const workspace = await deps.getOwnedWorkspace(ownerUserId, workspaceSlug)
  if (!workspace) return { ok: false, status: 404, reason: 'workspace_not_found', error: '工作区不存在' }
  const membership = await deps.getMemberRole(ownerUserId, workspaceSlug, scope.userId)
  const decision = decideWorkspaceAccess({
    tenantId: scope.tenantId,
    workspaceSlug,
    actorUserId: scope.userId,
    ownerUserId,
    membership: membership
      ? { tenantId: scope.tenantId, workspaceSlug, userId: scope.userId, role: membership }
      : null,
    action: 'read_workspace',
    sharedAccessEnabled: deps.sharedAccessEnabled,
  })
  if (!decision.allowed) {
    return { ok: false, status: 403, reason: decision.reason, error: '当前身份无权读取该共享工作区' }
  }
  return { ok: true, value: { ownerUserId, workspaceSlug, viewerRole: decision.role } }
}

/** 由真实存储装配依赖；开关默认关闭。 */
export function createSharedWorkspaceReadDeps(input: {
  workspaces: { getOwnedWorkspaceMetadata: (scope: AgentRuntimeScope, ownerUserId: string, workspaceSlug: string) => Promise<{ ownerUserId: string; workspaceSlug: string } | undefined> }
  memberships: { getMemberRole: (scope: AgentRuntimeScope, ownerUserId: string, workspaceSlug: string, memberUserId: string) => Promise<'editor' | 'viewer' | undefined> }
  scope: AgentRuntimeScope
  env?: Record<string, string | undefined>
}): SharedWorkspaceReadDeps {
  return {
    getOwnedWorkspace: (ownerUserId, workspaceSlug) => input.workspaces.getOwnedWorkspaceMetadata(input.scope, ownerUserId, workspaceSlug),
    getMemberRole: (ownerUserId, workspaceSlug, memberUserId) => input.memberships.getMemberRole(input.scope, ownerUserId, workspaceSlug, memberUserId),
    sharedAccessEnabled: isSharedWorkspaceAccessEnabled(input.env ?? process.env),
  }
}
