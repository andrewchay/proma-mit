import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
  test('Given 已认证用户 When 管理成员登记 Then 只能修改自己的工作区且明确尚未启用共享访问', async () => {
    const app = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/membership-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, auth: ({ request }) => { const userId = request.headers.get('x-test-user'); return userId ? { tenantId: tenant, userId, roles: ['operator'] } : undefined } })
    const request = (method: string, user: string, path: string, body?: string) => new Request(`http://server${path}`, { method, headers: { 'x-test-user': user, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) })
    const path = '/agent/workspaces/project/members/member-api'
    expect((await app.fetch(new Request('http://server/agent/workspaces/project/members'))).status).toBe(401)
    expect((await app.fetch(request('PUT', 'owner', path, '{"role":"owner"}'))).status).toBe(400)
    expect((await app.fetch(request('PUT', 'owner', path, JSON.stringify({ role: 'editor', padding: 'x'.repeat(5000) })))).status).toBe(400)
    expect((await app.fetch(request('PUT', 'owner', path, '{"role":"editor"}'))).status).toBe(200)
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
    const publish = '/agent/workspaces/project/shared-files/report.html'
    const shared = '/agent/shared-workspaces/owner/project/files/report.html'
    const request = (method: string, user: string, path: string, payload?: string, tenantId = tenant) => new Request(`http://server${path}`, { method, headers: { 'x-test-user': user, 'x-test-tenant': tenantId, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: payload } : {}) })
    expect((await app.fetch(request('GET', 'reader', shared))).status).toBe(404)
    expect((await app.fetch(request('GET', 'reader', '/agent/shared-workspaces/owner/project/files/%2e%2e%2Fsecret'))).status).toBe(404)
    expect((await app.fetch(request('PUT', 'outsider', publish, JSON.stringify({ expectedSha256: hash })))).status).toBe(403)
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: '0'.repeat(64) })))).status).toBe(409)
    expect((await app.fetch(request('PUT', 'owner', publish, JSON.stringify({ expectedSha256: hash })))).status).toBe(200)
    const unicodeKey = createAgentRuntimeWorkspaceObjectKey({ ...owner, workspaceSlug: 'project', relativePath: '目录/报告 %.txt' })
    await objects.putObject({ key: unicodeKey, body })
    const encodedPath = '%E7%9B%AE%E5%BD%95/%E6%8A%A5%E5%91%8A%20%25.txt'
    expect((await app.fetch(request('PUT', 'owner', `/agent/workspaces/project/shared-files/${encodedPath}`, JSON.stringify({ expectedSha256: hash })))).status).toBe(200)
    expect((await app.fetch(request('GET', 'reader', `/agent/shared-workspaces/owner/project/files/${encodedPath}`))).status).toBe(200)
    const download = await app.fetch(request('GET', 'reader', shared))
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toBe('attachment')
    expect(download.headers.get('cache-control')).toBe('private, no-store')
    expect(await download.text()).toBe('<html>approved</html>')
    expect((await app.fetch(request('GET', 'outsider', shared))).status).toBe(404)
    expect((await app.fetch(request('GET', 'reader', shared, undefined, `${tenant}-other`))).status).toBe(404)
    let signalFetch = () => {}, releaseFetch = () => {}
    const fetchStarted = new Promise<void>((resolve) => { signalFetch = resolve })
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve })
    const delayedObjects = {
      putObject: objects.putObject.bind(objects), deleteObject: objects.deleteObject.bind(objects), listObjects: objects.listObjects.bind(objects),
      getObject: async (objectKey: string) => { signalFetch(); await fetchGate; return objects.getObject(objectKey) },
    }
    const delayedApp = createPromaWebServerApplication({ databaseUrl: databaseUrl!, redisUrl: 'redis://unused', s3: { bucket: 'unused', region: 'auto', maxUploadBytes: 1024 }, envelopeKey: 'MDEyMzQ1Njc4OWFiY2RlZg', envelopeKeyId: 'test', trustedHeaderAuth: false, workspaceRoot: '/tmp/membership-test', workerId: 'test', taskLeaseMs: 30000 }, { postgres: client, objectStore: delayedObjects, auth: ({ request }) => ({ tenantId: tenant, userId: request.headers.get('x-test-user') ?? 'reader', roles: [request.headers.get('x-test-user') === 'owner' ? 'operator' : 'viewer'] }) })
    const inFlight = delayedApp.fetch(request('GET', 'reader', shared))
    await fetchStarted
    await members.removeMember(owner, 'project', 'reader')
    releaseFetch()
    expect((await inFlight).status).toBe(404)
    await members.setMember(owner, 'project', 'reader', 'viewer')
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
  })
})
