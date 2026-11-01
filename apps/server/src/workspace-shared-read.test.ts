/** 共享工作区元数据只读：集中授权在前、字段白名单在后，开关默认关闭。 */

import { describe, expect, test } from 'bun:test'
import type { AgentRuntimeScope } from '@gravitas/shared'
import { readSharedWorkspaceMetadata, type SharedWorkspaceReadDeps } from './workspace-shared-read.ts'

const scope: AgentRuntimeScope = { tenantId: 'tenant-1', userId: 'member-1' }

function deps(overrides: Partial<SharedWorkspaceReadDeps> & { exists?: boolean; role?: 'editor' | 'viewer' } = {}): SharedWorkspaceReadDeps {
  const { exists = true, role, ...rest } = overrides
  return {
    getOwnedWorkspace: async (ownerUserId, workspaceSlug) => exists ? { ownerUserId, workspaceSlug } : undefined,
    getMemberRole: async () => role,
    sharedAccessEnabled: false,
    ...rest,
  }
}

describe('共享工作区元数据只读', () => {
  test('Given 工作区不存在 When 读取 Then 404 且不进入授权判定', async () => {
    const result = await readSharedWorkspaceMetadata(scope, 'owner-1', 'design-ws', deps({ exists: false }))
    expect(result).toMatchObject({ ok: false, status: 404, reason: 'workspace_not_found' })
  })

  test('Given 非成员 When 开关即使打开 Then 403 not_a_member', async () => {
    const result = await readSharedWorkspaceMetadata(scope, 'owner-1', 'design-ws', deps({ sharedAccessEnabled: true }))
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'not_a_member' })
  })

  test('Given 成员但共享开关关闭 When 读取 Then 403 shared_workspace_disabled', async () => {
    const result = await readSharedWorkspaceMetadata(scope, 'owner-1', 'design-ws', deps({ role: 'viewer', sharedAccessEnabled: false }))
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'shared_workspace_disabled' })
  })

  test('Given viewer 与开关打开 When 读取 Then 只返回所有者、slug 与角色', async () => {
    const result = await readSharedWorkspaceMetadata(scope, 'owner-1', 'design-ws', deps({ role: 'viewer', sharedAccessEnabled: true }))
    expect(result).toEqual({ ok: true, value: { ownerUserId: 'owner-1', workspaceSlug: 'design-ws', viewerRole: 'viewer' } })
  })

  test('Given 所有者本人 When 读取 Then 角色为 owner 且不依赖开关', async () => {
    const ownerScope: AgentRuntimeScope = { tenantId: 'tenant-1', userId: 'owner-1' }
    const result = await readSharedWorkspaceMetadata(ownerScope, 'owner-1', 'design-ws', deps({ sharedAccessEnabled: false }))
    expect(result).toMatchObject({ ok: true, value: { viewerRole: 'owner' } })
  })

  test('Given 结果对象 When 序列化 Then 不含 cwd 或 MCP 配置字段', async () => {
    const result = await readSharedWorkspaceMetadata(scope, 'owner-1', 'design-ws', deps({ role: 'editor', sharedAccessEnabled: true }))
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('cwd')
    expect(serialized).not.toContain('mcpServers')
  })

  test('Given 所有者与成员身份同名判断 When 成员记录缺失 Then 归为非成员而不是默认 viewer', async () => {
    const result = await readSharedWorkspaceMetadata(scope, 'owner-1', 'design-ws', deps({ sharedAccessEnabled: true }))
    expect(result).toMatchObject({ ok: false, status: 403, reason: 'not_a_member' })
  })
})

describe('共享工作区只读路由', () => {
  test('Given 只接受 GET 与两段路径 When 匹配 Then 其余方法或其他路径不命中', async () => {
    const { matchSharedWorkspaceReadRoute } = await import('./workspace-shared-read-api.ts')
    expect(matchSharedWorkspaceReadRoute('GET', '/agent/shared-workspaces/owner-1/design-ws')).toEqual({ ownerUserId: 'owner-1', workspaceSlug: 'design-ws' })
    expect(matchSharedWorkspaceReadRoute('POST', '/agent/shared-workspaces/owner-1/design-ws')).toBeUndefined()
    expect(matchSharedWorkspaceReadRoute('GET', '/agent/shared-workspaces/owner-1')).toBeUndefined()
    expect(matchSharedWorkspaceReadRoute('GET', '/agent/shared-workspaces/owner-1/design-ws/files')).toBeUndefined()
    expect(matchSharedWorkspaceReadRoute('GET', '/agent/shared-workspaces/owner%2F1/design-ws')).toBeUndefined()
  })

  test('Given 未认证与成员两种情形 When 处理 Then 分别返回 401 语义与 403 原因码', async () => {
    const { handleSharedWorkspaceRead } = await import('./workspace-shared-read-api.ts')
    const workspaces = { getOwnedWorkspaceMetadata: async () => ({ ownerUserId: 'owner-1', workspaceSlug: 'design-ws' }) }
    const memberships = { getMemberRole: async () => 'viewer' as const }
    const response = await handleSharedWorkspaceRead(scope, { ownerUserId: 'owner-1', workspaceSlug: 'design-ws' }, workspaces as never, memberships as never)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: 'shared_workspace_disabled' })
  })

  test('Given 不存在的工作区 When 处理 Then 404 且不泄露其他字段', async () => {
    const { handleSharedWorkspaceRead } = await import('./workspace-shared-read-api.ts')
    const workspaces = { getOwnedWorkspaceMetadata: async () => undefined }
    const memberships = { getMemberRole: async () => undefined }
    const response = await handleSharedWorkspaceRead(scope, { ownerUserId: 'owner-1', workspaceSlug: 'missing' }, workspaces as never, memberships as never)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ reason: 'workspace_not_found' })
  })
})
