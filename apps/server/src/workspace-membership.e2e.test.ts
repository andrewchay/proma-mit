import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { PostgresTenantRuntimeStore } from '@gravitas/shared/utils'
import { PostgresWorkspaceMembershipStore } from './workspace-membership-store.ts'

const databaseUrl = process.env.PROMA_MEMBERSHIP_TEST_DATABASE_URL
describe.skipIf(!databaseUrl)('企业工作区成员的真实 Postgres 隔离', () => {
  const sql = new Bun.SQL(databaseUrl!)
  const otherSql = new Bun.SQL(databaseUrl!)
  const client = { query: <Row extends Record<string, unknown>>(statement: string, params: readonly unknown[] = []) => sql.unsafe<Row[]>(statement, [...params]).then((rows) => ({ rows })) }
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
    await workspaces.setWorkspace({ ...owner, workspaceSlug: 'project', cwd: '/ignored', mcpServers: {} })
  })
  afterAll(async () => {
    await sql.unsafe('DELETE FROM proma_runtime_workspaces WHERE tenant_id=$1', [tenant])
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
})
