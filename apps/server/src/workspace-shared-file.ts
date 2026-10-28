import { createHash } from 'node:crypto'
import { AgentRuntimeObjectTooLargeError, createAgentRuntimeWorkspaceObjectKey, normalizeRelativeObjectPath } from '@gravitas/shared/utils'
import type { AgentRuntimeObjectStore, AgentRuntimePostgresClient, AgentRuntimeScope, AgentRuntimeStoredObject } from '@gravitas/shared/utils'
import { createWorkspaceFileDownloadResponse } from './workspace-file-response.ts'
import { readBoundedJson } from './workspace-membership-api.ts'

interface SharedFileRoute { kind: 'owner' | 'member'; ownerUserId?: string; workspaceSlug: string; relativePath: string }
interface PublishedFile { sha256: string; size: number }

export class PostgresSharedFileStore {
  constructor(private readonly client: AgentRuntimePostgresClient) {}

  async initializeSchema(): Promise<void> {
    await this.client.query(`CREATE TABLE IF NOT EXISTS proma_workspace_shared_files (
      tenant_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, workspace_slug TEXT NOT NULL, relative_path TEXT NOT NULL,
      sha256 TEXT NOT NULL, size_bytes BIGINT NOT NULL, published_at BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, owner_user_id, workspace_slug, relative_path),
      FOREIGN KEY (tenant_id, owner_user_id, workspace_slug) REFERENCES proma_runtime_workspaces (tenant_id, user_id, workspace_slug) ON DELETE CASCADE
    )`)
  }

  async publish(scope: AgentRuntimeScope, route: SharedFileRoute, file: PublishedFile): Promise<boolean> {
    const result = await this.client.query(`INSERT INTO proma_workspace_shared_files (tenant_id, owner_user_id, workspace_slug, relative_path, sha256, size_bytes, published_at)
      SELECT tenant_id, user_id, workspace_slug, $4, $5, $6, $7 FROM proma_runtime_workspaces WHERE tenant_id=$1 AND user_id=$2 AND workspace_slug=$3
      ON CONFLICT (tenant_id, owner_user_id, workspace_slug, relative_path) DO UPDATE SET sha256=EXCLUDED.sha256, size_bytes=EXCLUDED.size_bytes, published_at=EXCLUDED.published_at RETURNING sha256`,
    [scope.tenantId, scope.userId, route.workspaceSlug, route.relativePath, file.sha256, file.size, Date.now()])
    return result.rows.length === 1
  }

  async unpublish(scope: AgentRuntimeScope, route: SharedFileRoute): Promise<boolean> {
    const result = await this.client.query('DELETE FROM proma_workspace_shared_files WHERE tenant_id=$1 AND owner_user_id=$2 AND workspace_slug=$3 AND relative_path=$4 RETURNING relative_path', [scope.tenantId, scope.userId, route.workspaceSlug, route.relativePath])
    return result.rows.length === 1
  }

  /** 同一查询内复核当前成员与发布记录，不信任调用者传入的租户。 */
  async findAuthorized(scope: AgentRuntimeScope, route: SharedFileRoute): Promise<PublishedFile | null> {
    const result = await this.client.query(`SELECT f.sha256, f.size_bytes FROM proma_workspace_shared_files f
      WHERE f.tenant_id=$1 AND f.owner_user_id=$2 AND f.workspace_slug=$3 AND f.relative_path=$4
      AND (f.owner_user_id=$5 OR EXISTS (SELECT 1 FROM proma_workspace_members m WHERE m.tenant_id=f.tenant_id AND m.owner_user_id=f.owner_user_id AND m.workspace_slug=f.workspace_slug AND m.member_user_id=$5))`,
    [scope.tenantId, route.ownerUserId, route.workspaceSlug, route.relativePath, scope.userId])
    const row = result.rows[0]
    if (!row) return null
    const size = Number(row.size_bytes)
    if (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(size) || size < 0) throw new Error('共享文件登记损坏')
    return { sha256: row.sha256, size }
  }
}

export function matchSharedFileRoute(method: string, pathname: string): SharedFileRoute | undefined {
  const parts = pathname.split('/')
  if (parts[1] !== 'agent') return undefined
  const owner = parts[2] === 'workspaces' && (method === 'PUT' || method === 'DELETE') && parts[4] === 'shared-files'
  const member = parts[2] === 'shared-workspaces' && method === 'GET' && parts[5] === 'files'
  if (!owner && !member) return undefined
  try {
    const ownerUserId = member ? decodeURIComponent(parts[3] ?? '') : undefined
    const workspaceSlug = decodeURIComponent(parts[member ? 4 : 3] ?? '')
    const relativePath = decodeURIComponent(parts.slice(member ? 6 : 5).join('/')).replaceAll('\\', '/')
    normalizeRelativeObjectPath(relativePath)
    const valid = (value: string) => value.length > 0 && value.length <= 200 && value.trim() === value && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    if (!valid(workspaceSlug) || (ownerUserId !== undefined && !valid(ownerUserId))) return undefined
    return { kind: owner ? 'owner' : 'member', ...(ownerUserId ? { ownerUserId } : {}), workspaceSlug, relativePath }
  } catch { return undefined }
}

export async function handleSharedFileRoute(request: Request, scope: AgentRuntimeScope, route: SharedFileRoute, store: PostgresSharedFileStore, objects: AgentRuntimeObjectStore, maxBytes: number): Promise<Response> {
  const ownerUserId = route.kind === 'owner' ? scope.userId : route.ownerUserId!
  const key = createAgentRuntimeWorkspaceObjectKey({ tenantId: scope.tenantId, userId: ownerUserId, workspaceSlug: route.workspaceSlug, relativePath: route.relativePath })
  if (route.kind === 'owner' && request.method === 'DELETE') return await store.unpublish(scope, route) ? new Response(null, { status: 204 }) : Response.json({ error: '共享文件不存在' }, { status: 404 })
  if (route.kind === 'owner') {
    const raw = await readBoundedJson(request)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Response.json({ error: '必须提供预期 SHA-256' }, { status: 400 })
    const body = raw as Record<string, unknown>
    if (Object.keys(body).length !== 1 || typeof body.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedSha256)) return Response.json({ error: '必须提供预期 SHA-256' }, { status: 400 })
    let object: AgentRuntimeStoredObject | undefined
    try { object = await objects.getObject(key, { maxBytes }) }
    catch (error) { if (error instanceof AgentRuntimeObjectTooLargeError) return Response.json({ error: '文件超过共享大小限制' }, { status: 413 }); throw error }
    if (!object) return Response.json({ error: '文件不存在或不可发布' }, { status: 404 })
    if (object.body.byteLength > maxBytes) return Response.json({ error: '文件超过共享大小限制' }, { status: 413 })
    const sha256 = createHash('sha256').update(object.body).digest('hex')
    if (sha256 !== body.expectedSha256) return Response.json({ error: '文件内容已变化，请重新核对' }, { status: 409 })
    return await store.publish(scope, route, { sha256, size: object.body.byteLength }) ? Response.json({ sha256, size: object.body.byteLength }) : Response.json({ error: '工作区不存在或不可发布' }, { status: 404 })
  }
  const before = await store.findAuthorized(scope, route)
  if (!before) return Response.json({ error: '文件不存在或不可访问' }, { status: 404 })
  let object: AgentRuntimeStoredObject | undefined
  let oversized = false
  try { object = await objects.getObject(key, { maxBytes: Math.min(before.size, maxBytes) }) }
  catch (error) { if (error instanceof AgentRuntimeObjectTooLargeError) oversized = true; else throw error }
  const after = await store.findAuthorized(scope, route)
  if (!after || after.sha256 !== before.sha256 || after.size !== before.size) return Response.json({ error: '文件不存在或不可访问' }, { status: 404 })
  if (oversized || !object || object.body.byteLength !== after.size || createHash('sha256').update(object.body).digest('hex') !== after.sha256) return Response.json({ error: '共享文件内容已变化，请所有者重新核对发布' }, { status: 409 })
  const response = createWorkspaceFileDownloadResponse(object.body, object.contentType)
  response.headers.set('cache-control', 'private, no-store')
  return response
}
