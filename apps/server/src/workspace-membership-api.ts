import type { AgentRuntimeScope, PostgresTenantRuntimeStore } from '@gravitas/shared/utils'
import type { PostgresWorkspaceMembershipStore } from './workspace-membership-store.ts'
import { isSharedWorkspaceAccessEnabled } from './workspace-access-policy.ts'

export interface WorkspaceMembershipRoute { workspaceSlug: string; memberUserId?: string }

export function matchWorkspaceMembershipRoute(method: string, pathname: string): WorkspaceMembershipRoute | undefined {
  const parts = pathname.split('/')
  if (parts[1] !== 'agent' || parts[2] !== 'workspaces' || parts[4] !== 'members') return undefined
  if (!(method === 'GET' && parts.length === 5) && !((method === 'PUT' || method === 'DELETE') && parts.length === 6)) return undefined
  try {
    const workspaceSlug = decodeURIComponent(parts[3] ?? '')
    const memberUserId = parts.length === 6 ? decodeURIComponent(parts[5] ?? '') : undefined
    const valid = (value: string) => value.length > 0 && value.length <= 200 && value.trim() === value && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    if (!valid(workspaceSlug) || (memberUserId !== undefined && !valid(memberUserId))) return undefined
    return { workspaceSlug, ...(memberUserId ? { memberUserId } : {}) }
  } catch { return undefined }
}

/** 仅管理认证用户自己持有的工作区登记；登记不授予实际 Runtime 访问。 */
export async function handleWorkspaceMembershipRoute(request: Request, scope: AgentRuntimeScope, route: WorkspaceMembershipRoute, workspaces: PostgresTenantRuntimeStore, memberships: PostgresWorkspaceMembershipStore): Promise<Response> {
  if (!await workspaces.getWorkspace(scope, route.workspaceSlug)) return Response.json({ error: '工作区不存在或不可管理' }, { status: 404 })
  // 共享工作区访问开关单一来源：默认关闭，登记仍只对已发布成果生效。
  const sharedAccessEnabled = isSharedWorkspaceAccessEnabled()
  if (request.method === 'GET') return Response.json({ sharedAccessEnabled, members: await memberships.listMembers(scope, route.workspaceSlug) })
  if (!route.memberUserId || route.memberUserId === scope.userId) return Response.json({ error: '成员身份无效' }, { status: 400 })
  if (request.method === 'DELETE') return await memberships.removeMember(scope, route.workspaceSlug, route.memberUserId) ? new Response(null, { status: 204 }) : Response.json({ error: '成员不存在' }, { status: 404 })
  const input = await readMembershipInput(request)
  if (!input) return Response.json({ error: '请求体必须包含有效 role 与可选 createOnly，且不超过 4KB' }, { status: 400 })
  const saved = await memberships.setMember(scope, route.workspaceSlug, route.memberUserId, input.role, { createOnly: input.createOnly })
  return saved ? Response.json({ registered: true, sharedAccessEnabled }) : Response.json({ error: input.createOnly ? '成员已存在或工作区不可管理，请重新读取' : '工作区不存在或不可管理' }, { status: input.createOnly ? 409 : 404 })
}

async function readMembershipInput(request: Request): Promise<{ role: 'editor' | 'viewer'; createOnly: boolean } | undefined> {
  const parsed = await readBoundedJson(request)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (!Object.keys(record).every(key => key === 'role' || key === 'createOnly') || (record.role !== 'editor' && record.role !== 'viewer') || (record.createOnly !== undefined && typeof record.createOnly !== 'boolean')) return undefined
  return { role: record.role, createOnly: record.createOnly === true }
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') || !request.body) return undefined
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let body = '', size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return undefined }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return JSON.parse(body) as unknown
  } catch { return undefined } finally { reader.releaseLock() }
}
