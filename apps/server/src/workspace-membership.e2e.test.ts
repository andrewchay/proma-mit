import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createAgentRuntimeWorkspaceObjectKey, InMemoryAgentRuntimeObjectStore, PostgresTenantRuntimeStore } from '@gravitas/shared/utils'
import { createHash } from 'node:crypto'
import { PostgresWorkspaceMembershipStore } from './workspace-membership-store.ts'
import { createPromaWebServerApplication } from './app.ts'
import { PostgresAuditLog } from './audit.ts'
import { PostgresSharedFileStore } from './workspace-shared-file.ts'

const databaseUrl = process.env.PROMA_MEMBERSHIP_TEST_DATABASE_URL
describe.skipIf(!databaseUrl)('企业工作区成员的真实 Postgres 隔离', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const otherSql = new Bun.SQL(databaseUrl!)
  const client = {
    query: <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => sql.unsafe<Row[]>(statement, [...params]).then((rows) => ({ rows })),
    transaction: async (run: (tx: import('@gravitas/shared/utils').AgentRuntimePostgresClient) => Promise<void>) => { await sql.begin(async (transaction) => { await run({ query: (statement, params = []) => transaction.unsafe(statement, [...params]).then((rows) => ({ rows })) }) }) },
  }
  const otherClient = { query: <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => otherSql.unsafe<Row[]>(statement, [...params]).then((rows) => ({ rows })) }
  const workspaces = new PostgresTenantRuntimeStore(client)
  const members = new PostgresWorkspaceMembershipStore(client)
  const second = new PostgresWorkspaceMembershipStore(otherClient)
  const tenant = `membership-${crypto.randomUUID()}`
  const owner = { tenantId: tenant, userId: 'owner' }
  const outsider = { tenantId: tenant, userId: 'outsider' }
  beforeAll(async () => {
    await workspaces.initializeSchema()
    await members.initializeSchema()
    await new PostgresSharedFileStore(client).initializeSchema()
    await new PostgresAuditLog(client).initializeSchema()
    await workspaces.setWorkspace({ ...owner, workspaceSlug: 'project', cwd: '/ignored', mcpServers: {} })
  })
  afterAll(async () => {
    await sql.unsafe('DELETE FROM proma_runtime_workspaces WHERE tenant_id=$1', [tenant])
    await sql.unsafe('DELETE FROM proma_runtime_audit_log WHERE tenant_id=$1', [tenant])
    await sql.close()
    await otherSql.close()
  })
  test('Given 所有者授权成员 When 第二实例查询 Then 持久化且租户与所有者隔离', async () => {
    expect(await members.setMember(owner, 'project', 'member', 'editor')).toBe(true)
    expect(await second.getRole({ tenantId: tenant, userId: 'member' }, 'owner', 'project')).toBe('editor')
    expect(await second.getRole({ tenantId: `${tenant}-other`, userId: 'member' }, 'owner', 'project')).toBeNull()
    expect(await second.getRole({ tenantId: tenant, userId: 'member' }, 'different-owner', 'project')).toBeNull()
    expect(await second.getRole(owner, 'owner', 'project')).toBe('owner')
    expect(await second.getRole(outsider, 'owner', 'project')).toBeNull()
    expect(await second.setMember(outsider, 'project', 'attacker', 'editor')).toBe(false)
    expect(await second.listMembers(outsider, 'project')).toEqual([])
    await expect(members.setMember(owner, 'project', 'member', 'owner' as never)).rejects.toThrow('无效')
    expect(await members.listMembers(owner, 'project')).toMatchObject([{ userId: 'member', role: 'editor' }])
    expect(await members.removeMember(owner, 'project', 'member')).toBe(true)
    expect(await second.getRole({ tenantId: tenant, userId: 'member' }, 'owner', 'project')).toBeNull()
  })
  test('Given 两个实例同时登记同一成员 When 仅允许新建 Then 仅一方成功且不覆盖角色', async () => {
    const outcomes = await Promise.all([
      members.setMember(owner, 'project', 'concurrent-member', 'editor', { createOnly: true }),
      second.setMember(owner, 'project', 'concurrent-member', 'viewer', { createOnly: true }),
    ])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(await members.getRole({ tenantId: tenant, userId: 'concurrent-member' }, 'owner', 'project')).toBe(outcomes[0] ? 'editor' : 'viewer')
    expect(await members.removeMember(owner, 'project', 'concurrent-member')).toBe(true)
  })
  test('Given 已认证用户 When 管理成员登记 Then 只能修改自己的工作区且明确尚未启用共享访问', async () => {
    const app = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/membership-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, auth: ({ request }) => { const userId = request.headers.get('x-test-user'); return userId ? { tenantId: tenant, userId, roles: ['operator'] } : undefined } })
    const request = (method: string, user: string, path: string, body?: string) => new Request(`http://server${path}`, { method, headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) })
    const path = '/agent/workspaces/project/members/member-api'
    expect((await app.fetch(new Request('http://server/agent/workspaces/project/members'))).status).toBe(401)
    expect((await app.fetch(request('PUT', 'owner', path, '{"role":"owner"}'))).status).toBe(400)
    expect((await app.fetch(request('PUT', 'owner', path, JSON.stringify({ role: 'editor', padding: 'x'.repeat(5000) })))).status).toBe(400)
    expect((await app.fetch(request('PUT', 'owner', path, '{"role":"editor"}'))).status).toBe(200)
    expect((await app.fetch(request('PUT', 'owner', path, '{"role":"viewer","createOnly":true}'))).status).toBe(409)
    expect(await members.getRole({ tenantId: tenant, userId: 'member-api' }, 'owner', 'project')).toBe('editor')
    expect((await app.fetch(request('PUT', 'outsider', path, '{"role":"viewer"}'))).status).toBe(404)
    expect((await app.fetch(request('GET', 'outsider', '/agent/workspaces/project/members'))).status).toBe(404)
    const listing = await app.fetch(request('GET', 'owner', '/agent/workspaces/project/members'))
    expect(await listing.json()).toMatchObject({ sharedAccessEnabled: false, members: [{ userId: 'member-api', role: 'editor' }] })
    expect((await app.fetch(request('DELETE', 'owner', path))).status).toBe(204)
    expect(await members.getRole({ tenantId: tenant, userId: 'member-api' }, 'owner', 'project')).toBeNull()
  })
  test('Given 所有者明确发布固定内容 When 成员读取 Then 可下载；撤权或内容变化后拒绝', async () => {
    const objects = new InMemoryAgentRuntimeObjectStore()
    const key = createAgentRuntimeWorkspaceObjectKey({ ...owner, workspaceSlug: 'project', relativePath: 'report.html' })
    const body = new TextEncoder().encode('<html>approved</html>')
    const hash = createHash('sha256').update(body).digest('hex')
    await objects.putObject({ key, body, contentType: 'text/html' })
    await members.setMember(owner, 'project', 'reader', 'viewer')
    const app = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/membership-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, objectStore: objects, auth: ({ request }) => ({ tenantId: request.headers.get('x-test-tenant') ?? tenant, userId: request.headers.get('x-test-user') ?? 'reader', roles: [request.headers.get('x-test-user') === 'owner' ? 'operator' : 'viewer'] }) })
    const ownerList = '/agent/workspaces/project/shared-files'
    const memberList = '/agent/shared-workspaces/owner/project/files'
    const publish = '/agent/workspaces/project/shared-files/report.html'
    const shared = '/agent/shared-workspaces/owner/project/files/report.html'
    const request = (method: string, user: string, path: string, payload?: string, tenantId = tenant) => new Request(`http://server${path}`, { method, headers: { 'x-test-user': user, 'x-test-tenant': tenantId, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: payload } : {}) })
    expect((await app.fetch(request('GET', 'reader', shared))).status).toBe(404)
    expect(await (await app.fetch(request('GET', 'reader', memberList))).json()).toEqual({ files: [], nextCursor: null })
    expect((await app.fetch(request('GET', 'outsider', memberList))).status).toBe(404)
    expect((await app.fetch(request('GET', 'reader', memberList, undefined, `${tenant}-other`))).status).toBe(404)
    const uploadPath = '/agent/workspaces/project/files/report.html'
    let cancelled = false
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1025)) }, cancel() { cancelled = true } })
    const upload = await app.fetch(new Request(`http://server${uploadPath}`, { method: 'PUT', headers: { 'x-test-user': 'owner', 'x-test-tenant': tenant, 'content-length': '1' }, body: oversized }))
    expect(upload.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(new TextDecoder().decode((await objects.getObject(key))!.body)).toBe('<html>approved</html>')
    const exact = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024)); controller.close() } })
    expect((await app.fetch(new Request('http://server/agent/workspaces/project/files/exact.bin', { method: 'PUT', headers: { 'x-test-user': 'owner', 'x-test-tenant': tenant }, body: exact }))).status).toBe(201)
    const exactKey = createAgentRuntimeWorkspaceObjectKey({ ...owner, workspaceSlug: 'project', relativePath: 'exact.bin' })
    expect((await objects.getObject(exactKey))!.body.byteLength).toBe(1024)
    const largeKey = createAgentRuntimeWorkspaceObjectKey({ ...owner, workspaceSlug: 'project', relativePath: 'large.bin' })
    const largeBody = new Uint8Array(1025)
    await objects.putObject({ key: largeKey, body: largeBody })
    const getObject = spyOn(objects, 'getObject')
    const ownerDownload = await app.fetch(request('GET', 'owner', '/agent/workspaces/project/files/large.bin'))
    expect(ownerDownload.status).toBe(200)
    expect((await ownerDownload.arrayBuffer()).byteLength).toBe(1025)
    expect(getObject).not.toHaveBeenCalled()
    getObject.mockRestore()
    expect((await app.fetch(request('PUT', 'owner', '/agent/workspaces/project/shared-files/large.bin', JSON.stringify({ expectedSha256: createHash('sha256').update(largeBody).digest('hex') })))).status).toBe(413)
    expect((await app.fetch(request('GET', 'reader', '/agent/shared-workspaces/owner/project/files/%2e%2e%2Fsecret'))).status).toBe(404)
    expect((await app.fetch(request('PUT', 'outsider', publish, JSON.stringify({ expectedSha256: hash })))).status).toBe(403)
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: '0'.repeat(64) })))).status).toBe(409)
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: hash })))).status).toBe(200)
    const unicodeKey = createAgentRuntimeWorkspaceObjectKey({ ...owner, workspaceSlug: 'project', relativePath: '目录/报告 %.txt' })
    await objects.putObject({ key: unicodeKey, body })
    const encodedPath = '%E7%9B%AE%E5%BD%95/%E6%8A%A5%E5%91%8A%20%25.txt'
    expect((await app.fetch(request('PUT', 'owner', `/agent/workspaces/project/shared-files/${encodedPath}`, JSON.stringify({ expectedSha256: hash })))).status).toBe(200)
    expect((await app.fetch(request('GET', 'reader', `/agent/shared-workspaces/owner/project/files/${encodedPath}`))).status).toBe(200)
    const listing = await app.fetch(request('GET', 'reader', memberList))
    expect(listing.headers.get('cache-control')).toBe('private, no-store')
    expect(await listing.json()).toMatchObject({ files: [{ path: 'report.html', sha256: hash }, { path: '目录/报告 %.txt', sha256: hash }], nextCursor: null })
    const ownerListing = await (await app.fetch(request('GET', 'owner', ownerList))).json() as { files: Array<{ path: string; publicationId: string }> }
    const firstVersion = ownerListing.files.find(file => file.path === 'report.html')!.publicationId
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: hash })))).status).toBe(200)
    const currentListing = await (await app.fetch(request('GET', 'owner', ownerList))).json() as { files: Array<{ path: string; publicationId: string }> }
    const currentVersion = currentListing.files.find(file => file.path === 'report.html')!.publicationId
    expect(currentVersion).not.toBe(firstVersion)
    expect((await app.fetch(request('DELETE', 'owner', `${publish}?publicationId=${firstVersion}`))).status).toBe(409)
    expect((await app.fetch(request('GET', 'reader', shared))).status).toBe(200)
    expect((await app.fetch(request('DELETE', 'owner', `${publish}?publicationId=${currentVersion}`))).status).toBe(204)
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: hash })))).status).toBe(200)
    const download = await app.fetch(request('GET', 'reader', shared))
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toBe('attachment')
    expect(download.headers.get('cache-control')).toBe('private, no-store')
    expect(await download.text()).toBe('<html>approved</html>')
    expect((await app.fetch(request('GET', 'outsider', shared))).status).toBe(404)
    expect((await app.fetch(request('GET', 'reader', shared, undefined, `${tenant}-other`))).status).toBe(404)
    let signalRepublishRead = () => {}, releaseRepublishRead = () => {}
    const republishReadStarted = new Promise<void>(resolve => { signalRepublishRead = resolve })
    const republishReadGate = new Promise<void>(resolve => { releaseRepublishRead = resolve })
    const republishObjects = {
      putObject: objects.putObject.bind(objects), deleteObject: objects.deleteObject.bind(objects), listObjects: objects.listObjects.bind(objects),
      getObject: async (objectKey: string, options?: { maxBytes: number }) => { signalRepublishRead(); await republishReadGate; return objects.getObject(objectKey, options) },
    }
    const republishApp = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/membership-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, objectStore: republishObjects, auth: ({ request }) => ({ tenantId: tenant, userId: request.headers.get('x-test-user') ?? 'reader', roles: ['viewer'] }) })
    const staleRead = republishApp.fetch(request('GET', 'reader', shared))
    await republishReadStarted
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: hash })))).status).toBe(200)
    releaseRepublishRead()
    expect((await staleRead).status).toBe(404)
    let signalFetch = () => {}, releaseFetch = () => {}
    const fetchStarted = new Promise<void>((resolve) => { signalFetch = resolve })
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve })
    const delayedObjects = {
      putObject: objects.putObject.bind(objects), deleteObject: objects.deleteObject.bind(objects), listObjects: objects.listObjects.bind(objects),
      getObject: async (objectKey: string, options?: { maxBytes: number }) => { signalFetch(); await fetchGate; return objects.getObject(objectKey, options) },
    }
    const delayedApp = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/membership-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, objectStore: delayedObjects, auth: ({ request }) => ({ tenantId: tenant, userId: request.headers.get('x-test-user') ?? 'reader', roles: [request.headers.get('x-test-user') === 'owner' ? 'operator' : 'viewer'] }) })
    const inFlight = delayedApp.fetch(request('GET', 'reader', shared))
    await fetchStarted
    await members.removeMember(owner, 'project', 'reader')
    await objects.putObject({ key, body: new Uint8Array(1025) })
    releaseFetch()
    expect((await inFlight).status).toBe(404)
    await members.setMember(owner, 'project', 'reader', 'viewer')
    expect((await app.fetch(request('GET', 'reader', shared))).status).toBe(409)
    await objects.putObject({ key, body: new TextEncoder().encode('changed') })
    expect((await app.fetch(request('GET', 'reader', shared))).status).toBe(409)
    const updatedHash = createHash('sha256').update('changed').digest('hex')
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: updatedHash })))).status).toBe(200)
    expect(await (await app.fetch(request('GET', 'reader', shared))).text()).toBe('changed')
    expect((await app.fetch(request('DELETE', 'owner', publish))).status).toBe(204)
    expect((await app.fetch(request('GET', 'reader', shared))).status).toBe(404)
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: updatedHash })))).status).toBe(200)
    await members.removeMember(owner, 'project', 'reader')
    expect((await app.fetch(request('GET', 'reader', shared))).status).toBe(404)
    expect((await app.fetch(request('GET', 'reader', memberList))).status).toBe(404)
  })
  test('Given 超过一页的发布记录 When 成员分页或撤权 Then 返回准确游标并重新检查权限', async () => {
    await workspaces.setWorkspace({ ...owner, workspaceSlug: 'pagination', cwd: '/ignored', mcpServers: {} })
    await members.setMember(owner, 'pagination', 'reader-pages', 'viewer')
    await sql.unsafe(`INSERT INTO proma_workspace_shared_files (tenant_id, owner_user_id, workspace_slug, relative_path, sha256, size_bytes, published_at) SELECT $1, 'owner', 'pagination', 'file-' || lpad(n::text, 3, '0'), $2, 1, 1 FROM generate_series(1, 101) n`, [tenant, 'a'.repeat(64)])
    const app = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/membership-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, auth: () => ({ tenantId: tenant, userId: 'reader-pages', roles: ['viewer'] }) })
    const path = 'http://server/agent/shared-workspaces/owner/pagination/files'
    const first = await (await app.fetch(new Request(path))).json() as { files: Array<{ path: string }>; nextCursor: string | null }
    expect(first.files).toHaveLength(100)
    expect(first.nextCursor).toBe('file-100')
    const next = await (await app.fetch(new Request(path + '?after=' + encodeURIComponent(first.nextCursor!)))).json() as { files: Array<{ path: string }>; nextCursor: string | null }
    expect(next.files.map(file => file.path)).toEqual(['file-101'])
    expect(next.nextCursor).toBeNull()
    expect((await app.fetch(new Request(path + '?after=a&after=b'))).status).toBe(400)
    await members.removeMember(owner, 'pagination', 'reader-pages')
    expect((await app.fetch(new Request(path + '?after=file-100'))).status).toBe(404)
  })

})
