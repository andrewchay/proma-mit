import type { AgentRuntimeScope, PostgresTenantRuntimeStore } from '@gravitas/shared/utils'
import type { PostgresWorkspaceMembershipStore } from './workspace-membership-store.ts'

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
  if (request.method === 'GET') return Response.json({ sharedAccessEnabled: false, members: await memberships.listMembers(scope, route.workspaceSlug) })
  if (!route.memberUserId || route.memberUserId === scope.userId) return Response.json({ error: '成员身份无效' }, { status: 400 })
  if (request.method === 'DELETE') return await memberships.removeMember(scope, route.workspaceSlug, route.memberUserId) ? new Response(null, { status: 204 }) : Response.json({ error: '成员不存在' }, { status: 404 })
  const role = await readRole(request)
  if (!role) return Response.json({ error: '请求体必须是仅含有效 role 的 JSON，且不超过 4KB' }, { status: 400 })
  const saved = await memberships.setMember(scope, route.workspaceSlug, route.memberUserId, role)
  return saved ? Response.json({ registered: true, sharedAccessEnabled: false }) : Response.json({ error: '工作区不存在或不可管理' }, { status: 404 })
}

async function readRole(request: Request): Promise<'editor' | 'viewer' | undefined> {
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
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    return Object.keys(record).length === 1 && (record.role === 'editor' || record.role === 'viewer') ? record.role : undefined
  } catch { return undefined } finally { reader.releaseLock() }
}
