/**
 * 团队协作服务
 *
 * 为企业版提供工作区共享、成员邀请、角色分配等功能。
 */

import type { AgentRuntimeScope } from '@gravitas/shared'
import type { WorkspaceMember, WorkspaceRole, WorkspaceInvitation } from './workspace-permission.ts'

export interface TeamCollaborationService {
  /** 邀请成员加入工作区 */
  inviteMember(
    scope: AgentRuntimeScope,
    workspaceSlug: string,
    email: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceInvitation>

  /** 接受邀请 */
  acceptInvitation(invitationId: string, userId: string): Promise<WorkspaceMember | null>

  /** 拒绝邀请 */
  declineInvitation(invitationId: string): Promise<boolean>

  /** 移除工作区成员 */
  removeMember(
    scope: AgentRuntimeScope,
    workspaceSlug: string,
    userId: string,
  ): Promise<boolean>

  /** 更新成员角色 */
  updateMemberRole(
    scope: AgentRuntimeScope,
    workspaceSlug: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember | null>

  /** 移交工作区所有权 */
  transferOwnership(
    scope: AgentRuntimeScope,
    workspaceSlug: string,
    newOwnerId: string,
  ): Promise<boolean>

  /** 获取工作区成员列表 */
  listMembers(workspaceSlug: string): Promise<WorkspaceMember[]>

  /** 获取工作区邀请列表 */
  listInvitations(workspaceSlug: string): Promise<WorkspaceInvitation[]>
}

/** 内存存储（实际应用应使用 Postgres） */
const membersStore: WorkspaceMember[] = []
const invitationsStore: WorkspaceInvitation[] = []

export function createTeamCollaborationService(): TeamCollaborationService {
  return {
    async inviteMember(
      scope: AgentRuntimeScope,
      workspaceSlug: string,
      email: string,
      role: WorkspaceRole,
    ): Promise<WorkspaceInvitation> {
      const invitation: WorkspaceInvitation = {
        id: crypto.randomUUID(),
        workspaceSlug,
        invitedBy: scope.userId,
        invitedUserEmail: email,
        role,
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 天过期
        status: 'pending',
      }
      invitationsStore.push(invitation)
      return invitation
    },

    async acceptInvitation(invitationId: string, userId: string): Promise<WorkspaceMember | null> {
      const invitation = invitationsStore.find((i) => i.id === invitationId && i.status === 'pending')
      if (!invitation) return null
      if (Date.now() > invitation.expiresAt) return null

      invitation.status = 'accepted'

      const member: WorkspaceMember = {
        userId,
        workspaceSlug: invitation.workspaceSlug,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
        joinedAt: Date.now(),
      }
      membersStore.push(member)
      return member
    },

    async declineInvitation(invitationId: string): Promise<boolean> {
      const invitation = invitationsStore.find((i) => i.id === invitationId && i.status === 'pending')
      if (!invitation) return false
      invitation.status = 'declined'
      return true
    },

    async removeMember(
      _scope: AgentRuntimeScope,
      workspaceSlug: string,
      userId: string,
    ): Promise<boolean> {
      const index = membersStore.findIndex(
        (m) => m.workspaceSlug === workspaceSlug && m.userId === userId,
      )
      if (index === -1) return false
      membersStore.splice(index, 1)
      return true
    },

    async updateMemberRole(
      _scope: AgentRuntimeScope,
      workspaceSlug: string,
      userId: string,
      role: WorkspaceRole,
    ): Promise<WorkspaceMember | null> {
      const member = membersStore.find(
        (m) => m.workspaceSlug === workspaceSlug && m.userId === userId,
      )
      if (!member) return null
      member.role = role
      return member
    },

    async transferOwnership(
      _scope: AgentRuntimeScope,
      workspaceSlug: string,
      newOwnerId: string,
    ): Promise<boolean> {
      // 将原 owner 降级为 editor
      const currentOwner = membersStore.find(
        (m) => m.workspaceSlug === workspaceSlug && m.role === 'owner',
      )
      if (currentOwner) {
        currentOwner.role = 'editor'
      }

      // 将新用户设为 owner
      const newOwner = membersStore.find(
        (m) => m.workspaceSlug === workspaceSlug && m.userId === newOwnerId,
      )
      if (newOwner) {
        newOwner.role = 'owner'
        return true
      }
      return false
    },

    async listMembers(workspaceSlug: string): Promise<WorkspaceMember[]> {
      return membersStore.filter((m) => m.workspaceSlug === workspaceSlug)
    },

    async listInvitations(workspaceSlug: string): Promise<WorkspaceInvitation[]> {
      return invitationsStore.filter((i) => i.workspaceSlug === workspaceSlug)
    },
  }
}
