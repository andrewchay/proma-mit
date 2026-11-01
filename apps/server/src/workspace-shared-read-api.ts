/**
 * 共享工作区元数据只读路由：GET /agent/shared-workspaces/{ownerUserId}/{workspaceSlug}
 *
 * 与文件清单路由同一命名空间，但只返回所有者、slug 与当前角色；是否放行由集中授权决定。
 * 开关关闭时成员会收到 403 + `shared_workspace_disabled`，不会静默变成 404。
 */

import type { AgentRuntimeScope } from '@gravitas/shared'
import type { PostgresWorkspaceMembershipStore } from './workspace-membership-store.ts'
import type { PostgresTenantRuntimeStore } from '@gravitas/shared/utils'
import { createSharedWorkspaceReadDeps, readSharedWorkspaceMetadata } from './workspace-shared-read.ts'

export interface SharedWorkspaceReadRoute { ownerUserId: string; workspaceSlug: string }

export function matchSharedWorkspaceReadRoute(method: string, pathname: string): SharedWorkspaceReadRoute | undefined {
  if (method !== 'GET') return undefined
  const parts = pathname.split('/')
  if (parts.length !== 5 || parts[1] !== 'agent' || parts[2] !== 'shared-workspaces') return undefined
  try {
    const ownerUserId = decodeURIComponent(parts[3] ?? '')
    const workspaceSlug = decodeURIComponent(parts[4] ?? '')
    const valid = (value: string) => value.length > 0 && value.length <= 200 && value.trim() === value && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    if (!valid(ownerUserId) || !valid(workspaceSlug)) return undefined
    return { ownerUserId, workspaceSlug }
  } catch { return undefined }
}

export async function handleSharedWorkspaceRead(
  scope: AgentRuntimeScope,
  route: SharedWorkspaceReadRoute,
  workspaces: PostgresTenantRuntimeStore,
  memberships: PostgresWorkspaceMembershipStore,
): Promise<Response> {
  const deps = createSharedWorkspaceReadDeps({ workspaces, memberships, scope })
  const result = await readSharedWorkspaceMetadata(scope, route.ownerUserId, route.workspaceSlug, deps)
  if (!result.ok) return Response.json({ error: result.error, reason: result.reason }, { status: result.status })
  return Response.json(result.value, { headers: { 'cache-control': 'private, no-store' } })
}
