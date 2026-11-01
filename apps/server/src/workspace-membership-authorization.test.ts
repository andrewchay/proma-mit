/**
 * 成员接口的集中授权自检：只有工作区所有者能管理成员，非所有者失败关闭。
 *
 * 用桩替代 Postgres：本测试只验证判定接线与响应码，不验证 SQL 或真实成员存储
 * （那部分由 workspace-membership.e2e.test.ts 在真实库上覆盖）。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeScope } from '@gravitas/shared'
import { handleWorkspaceMembershipRoute, matchWorkspaceMembershipRoute } from './workspace-membership-api.ts'

const scope: AgentRuntimeScope = { tenantId: 'tenant-1', userId: 'owner-1' }

const workspaceOf = (userId: string) => ({ tenantId: 'tenant-1', userId, workspaceSlug: 'design-ws', cwd: '/ignored', mcpServers: {} })

function stubDependencies(ownerUserId: string | null) {
  const calls: string[] = []
  const workspaces = {
    getWorkspace: async (_scope: AgentRuntimeScope, workspaceSlug: string) => {
      calls.push(`getWorkspace:${workspaceSlug}`)
      return ownerUserId === null ? undefined : workspaceOf(ownerUserId)
    },
  }
  const memberships = {
    listMembers: async () => { calls.push('listMembers'); return [{ userId: 'member-1', role: 'viewer' as const }] },
    setMember: async () => { calls.push('setMember'); return true },
    removeMember: async () => { calls.push('removeMember'); return true },
  }
  return { calls, workspaces, memberships }
}

const request = (method: string, body?: unknown) => new Request('http://localhost/agent/workspaces/design-ws/members', {
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
})

describe('成员接口的集中授权', () => {
  test('Given 所有者读取成员 When 判定 Then 放行且响应带共享开关', async () => {
    const deps = stubDependencies('owner-1')
    const response = await handleWorkspaceMembershipRoute(
      request('GET'),
      scope,
      { workspaceSlug: 'design-ws' },
      deps.workspaces as never,
      deps.memberships as never,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sharedAccessEnabled: false, members: [{ userId: 'member-1' }] })
    expect(deps.calls).toEqual(['getWorkspace:design-ws', 'listMembers'])
  })

  test('Given 工作区属于其他用户 When 登记成员 Then 403 且不写库', async () => {
    const deps = stubDependencies('someone-else')
    const response = await handleWorkspaceMembershipRoute(
      request('PUT', { role: 'viewer' }),
      scope,
      { workspaceSlug: 'design-ws', memberUserId: 'member-2' },
      deps.workspaces as never,
      deps.memberships as never,
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: 'not_a_member' })
    expect(deps.calls).toEqual(['getWorkspace:design-ws'])
  })

  test('Given 工作区属于其他用户 When 读取或撤销成员 Then 一律 403', async () => {
    for (const method of ['GET', 'DELETE']) {
      const deps = stubDependencies('someone-else')
      const response = await handleWorkspaceMembershipRoute(
        request(method),
        scope,
        { workspaceSlug: 'design-ws', memberUserId: method === 'DELETE' ? 'member-2' : undefined },
        deps.workspaces as never,
        deps.memberships as never,
      )
      expect(response.status).toBe(403)
      expect(deps.calls).toEqual(['getWorkspace:design-ws'])
    }
  })

  test('Given 工作区不存在 When 任何动作 Then 404 且不做判定副作用', async () => {
    const deps = stubDependencies(null)
    const response = await handleWorkspaceMembershipRoute(
      request('GET'),
      scope,
      { workspaceSlug: 'design-ws' },
      deps.workspaces as never,
      deps.memberships as never,
    )
    expect(response.status).toBe(404)
    expect(deps.calls).toEqual(['getWorkspace:design-ws'])
  })

  test('Given 成员接口路径 When 匹配 Then 只接受成员相关方法', () => {
    expect(matchWorkspaceMembershipRoute('GET', '/agent/workspaces/design-ws/members')).toMatchObject({ workspaceSlug: 'design-ws' })
    expect(matchWorkspaceMembershipRoute('PUT', '/agent/workspaces/design-ws/members/member-1')).toMatchObject({ workspaceSlug: 'design-ws', memberUserId: 'member-1' })
    expect(matchWorkspaceMembershipRoute('POST', '/agent/workspaces/design-ws/members')).toBeUndefined()
    expect(matchWorkspaceMembershipRoute('GET', '/agent/workspaces/design-ws/members/member-1')).toBeUndefined()
  })
})
