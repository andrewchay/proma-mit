/**
 * 工作区集中授权模型测试：判定表、失败关闭与开关语义。
 */

import { describe, expect, test } from 'bun:test'
import {
  decideWorkspaceAccess,
  isSharedWorkspaceAccessEnabled,
  type WorkspaceAccessRequest,
} from './workspace-access-policy.ts'

const base: Omit<WorkspaceAccessRequest, 'action' | 'membership' | 'sharedAccessEnabled' | 'actorUserId'> = {
  tenantId: 'tenant-1',
  workspaceSlug: 'design-ws',
  ownerUserId: 'owner-1',
}

const member = (role: 'editor' | 'viewer', overrides: Partial<{ tenantId: string; workspaceSlug: string; userId: string }> = {}) => ({
  tenantId: 'tenant-1',
  workspaceSlug: 'design-ws',
  userId: 'member-1',
  role,
  ...overrides,
})

describe('工作区集中授权', () => {
  test('Given 所有者 When 任意已知动作 Then 允许且不依赖共享开关', () => {
    for (const action of ['read_workspace', 'write_workspace', 'run_runtime', 'manage_members', 'read_published_artifact'] as const) {
      const decision = decideWorkspaceAccess({ ...base, actorUserId: 'owner-1', action, sharedAccessEnabled: false })
      expect(decision).toMatchObject({ allowed: true, reason: 'owner', role: 'owner' })
    }
  })

  test('Given 非成员 When 读取工作区 Then 拒绝', () => {
    const decision = decideWorkspaceAccess({ ...base, actorUserId: 'stranger', action: 'read_workspace', sharedAccessEnabled: true })
    expect(decision).toMatchObject({ allowed: false, reason: 'not_a_member' })
  })

  test('Given 成员记录属于他人 When 判定 Then 不当成成员', () => {
    const decision = decideWorkspaceAccess({
      ...base,
      actorUserId: 'member-2',
      action: 'read_workspace',
      membership: member('editor'),
      sharedAccessEnabled: true,
    })
    expect(decision).toMatchObject({ allowed: false, reason: 'not_a_member' })
  })

  test('Given 共享开关关闭 When 成员读取或启动 Runtime Then 拒绝并说明原因', () => {
    for (const action of ['read_workspace', 'write_workspace', 'run_runtime'] as const) {
      const decision = decideWorkspaceAccess({ ...base, actorUserId: 'member-1', action, membership: member('editor'), sharedAccessEnabled: false })
      expect(decision).toMatchObject({ allowed: false, reason: 'shared_workspace_disabled', role: 'editor' })
    }
  })

  test('Given 共享开关开启 When 成员按角色动作 Then 只放行表内动作', () => {
    const allowed = (role: 'editor' | 'viewer', action: 'read_workspace' | 'write_workspace' | 'run_runtime') =>
      decideWorkspaceAccess({ ...base, actorUserId: 'member-1', action, membership: member(role), sharedAccessEnabled: true }).allowed
    expect(allowed('viewer', 'read_workspace')).toBe(true)
    expect(allowed('viewer', 'write_workspace')).toBe(false)
    expect(allowed('viewer', 'run_runtime')).toBe(false)
    expect(allowed('editor', 'write_workspace')).toBe(true)
    expect(allowed('editor', 'run_runtime')).toBe(true)
  })

  test('Given 成员不是所有者 When 管理成员 Then 一律拒绝', () => {
    for (const role of ['editor', 'viewer'] as const) {
      const decision = decideWorkspaceAccess({ ...base, actorUserId: 'member-1', action: 'manage_members', membership: member(role), sharedAccessEnabled: true })
      expect(decision).toMatchObject({ allowed: false, reason: 'role_insufficient', role })
    }
  })

  test('Given 已发布成果 When 成员读取 Then 不依赖共享开关', () => {
    const decision = decideWorkspaceAccess({
      ...base,
      actorUserId: 'member-1',
      action: 'read_published_artifact',
      membership: member('viewer'),
      sharedAccessEnabled: false,
    })
    expect(decision).toMatchObject({ allowed: true, reason: 'published_artifact_member', role: 'viewer' })
  })

  test('Given 成员记录跨租户或跨工作区 When 判定 Then 拒绝为范围不匹配', () => {
    const crossTenant = decideWorkspaceAccess({
      ...base,
      actorUserId: 'member-1',
      action: 'read_workspace',
      membership: member('editor', { tenantId: 'tenant-2' }),
      sharedAccessEnabled: true,
    })
    expect(crossTenant).toMatchObject({ allowed: false, reason: 'membership_scope_mismatch' })
    const crossWorkspace = decideWorkspaceAccess({
      ...base,
      actorUserId: 'member-1',
      action: 'read_workspace',
      membership: member('editor', { workspaceSlug: 'other-ws' }),
      sharedAccessEnabled: true,
    })
    expect(crossWorkspace).toMatchObject({ allowed: false, reason: 'membership_scope_mismatch' })
  })

  test('Given 未知动作 When 判定 Then 失败关闭', () => {
    const ownerDecision = decideWorkspaceAccess({ ...base, actorUserId: 'owner-1', action: 'delete_everything' as never, sharedAccessEnabled: true })
    expect(ownerDecision).toMatchObject({ allowed: false, reason: 'unknown_action' })
    const memberDecision = decideWorkspaceAccess({
      ...base,
      actorUserId: 'member-1',
      action: 'delete_everything' as never,
      membership: member('editor'),
      sharedAccessEnabled: true,
    })
    expect(memberDecision).toMatchObject({ allowed: false, reason: 'unknown_action' })
  })

  test('Given 共享开关环境变量 When 未设置或非 1 Then 默认关闭', () => {
    expect(isSharedWorkspaceAccessEnabled({})).toBe(false)
    expect(isSharedWorkspaceAccessEnabled({ GRAVITAS_SHARED_WORKSPACE_ACCESS: 'true' })).toBe(false)
    expect(isSharedWorkspaceAccessEnabled({ GRAVITAS_SHARED_WORKSPACE_ACCESS: '1' })).toBe(true)
  })
})
