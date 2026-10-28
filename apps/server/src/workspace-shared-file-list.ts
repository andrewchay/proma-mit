import type { AgentRuntimePostgresClient, AgentRuntimeScope } from '@gravitas/shared/utils'

interface SharedFileListRoute { ownerUserId?: string; workspaceSlug: string }

/** 列表只包含显式发布的文件，访问范围由服务端身份和当前成员记录决定。 */
export function matchSharedFileListRoute(method: string, pathname: string): SharedFileListRoute | undefined {
  if (method !== 'GET') return undefined
  const parts = pathname.split('/')
  const owner = parts.length === 5 && parts[1] === 'agent' && parts[2] === 'workspaces' && parts[4] === 'shared-files'
  const member = parts.length === 6 && parts[1] === 'agent' && parts[2] === 'shared-workspaces' && parts[5] === 'files'
  if (!owner && !member) return undefined
  try {
    const ownerUserId = member ? decodeURIComponent(parts[3] ?? '') : undefined
    const workspaceSlug = decodeURIComponent(parts[member ? 4 : 3] ?? '')
    const valid = (value: string) => value.length > 0 && value.length <= 200 && value.trim() === value && !/[\/\\\u0000-\u001f\u007f]/.test(value)
    if (!valid(workspaceSlug) || (ownerUserId !== undefined && !valid(ownerUserId))) return undefined
    return { workspaceSlug, ...(ownerUserId ? { ownerUserId } : {}) }
  } catch { return undefined }
}

export async function handleSharedFileList(request: Request, scope: AgentRuntimeScope, route: SharedFileListRoute, db: AgentRuntimePostgresClient): Promise<Response> {
  const params = new URL(request.url).searchParams
  const cursors = params.getAll('after')
  if (cursors.length > 1 || (cursors[0] !== undefined && (!cursors[0] || cursors[0].length > 4096 || cursors[0].includes('\0')))) return Response.json({ error: '分页位置无效' }, { status: 400 })
  const owner = route.ownerUserId ?? scope.userId
  const result = await db.query(`WITH permitted AS (
      SELECT w.tenant_id, w.user_id, w.workspace_slug FROM proma_runtime_workspaces w
      WHERE w.tenant_id=$1 AND w.user_id=$2 AND w.workspace_slug=$3
      AND (w.user_id=$4 OR EXISTS (SELECT 1 FROM proma_workspace_members m WHERE m.tenant_id=w.tenant_id AND m.owner_user_id=w.user_id AND m.workspace_slug=w.workspace_slug AND m.member_user_id=$4))
    ) SELECT f.relative_path, f.sha256, f.size_bytes, f.published_at FROM permitted w
      LEFT JOIN proma_workspace_shared_files f ON f.tenant_id=w.tenant_id AND f.owner_user_id=w.user_id AND f.workspace_slug=w.workspace_slug
      AND ($5::text IS NULL OR f.relative_path COLLATE "C" > $5 COLLATE "C")
      ORDER BY f.relative_path COLLATE "C" LIMIT 101`, [scope.tenantId, owner, route.workspaceSlug, scope.userId, cursors[0] ?? null])
  if (!result.rows.length) return Response.json({ error: '工作区不存在或不可访问' }, { status: 404 })
  const rows = result.rows.filter(row => row.relative_path !== null)
  const files = rows.slice(0, 100).map(row => {
    const size = Number(row.size_bytes), publishedAt = Number(row.published_at)
    if (typeof row.relative_path !== 'string' || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(publishedAt) || publishedAt < 0) throw new Error('共享文件登记损坏')
    return { path: row.relative_path, sha256: row.sha256, size, publishedAt }
  })
  return Response.json({ files, nextCursor: rows.length > 100 ? files[files.length - 1]!.path : null }, { headers: { 'cache-control': 'private, no-store' } })
}
