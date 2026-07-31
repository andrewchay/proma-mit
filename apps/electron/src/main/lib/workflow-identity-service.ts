/** Workflow 审批身份目录。当前采用本地 JSON，可由企业同步连接器替换。 */

import type { WorkflowApprovalConfig, WorkflowDefinition, WorkflowIdentityDirectory } from '@proma/shared'
import { getWorkflowIdentityDirectoryPath } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

const DEFAULT_DIRECTORY: WorkflowIdentityDirectory = {
  users: [{ id: 'local-user', displayName: '本地用户', roleIds: [], enabled: true }],
  roles: [],
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

export function getWorkflowIdentityDirectory(): WorkflowIdentityDirectory {
  return readJsonFileSafe<WorkflowIdentityDirectory>(getWorkflowIdentityDirectoryPath()) ?? clone(DEFAULT_DIRECTORY)
}

export function saveWorkflowIdentityDirectory(directory: WorkflowIdentityDirectory): WorkflowIdentityDirectory {
  const userIds = new Set<string>()
  const roleIds = new Set<string>()
  for (const user of directory.users) {
    if (!user.id.trim() || userIds.has(user.id)) throw new Error(`审批用户 ID 无效或重复: ${user.id}`)
    userIds.add(user.id)
  }
  for (const role of directory.roles) {
    if (!role.id.trim() || roleIds.has(role.id)) throw new Error(`审批角色 ID 无效或重复: ${role.id}`)
    roleIds.add(role.id)
    if (role.memberIds.some((id) => !userIds.has(id))) throw new Error(`角色 ${role.id} 引用了不存在的用户`)
  }
  writeJsonFileAtomic(getWorkflowIdentityDirectoryPath(), directory)
  return clone(directory)
}

/** 在创建 Run 审批时解析并冻结可审批人。 */
export function resolveWorkflowApprovalAssignees(definition: WorkflowDefinition, config: WorkflowApprovalConfig): string[] {
  const directory = getWorkflowIdentityDirectory()
  const enabledUsers = new Set(directory.users.filter((user) => user.enabled).map((user) => user.id))
  const configured = config.assigneePolicy === 'workflow_owner'
    ? [definition.publication?.publishedBy ?? 'local-user']
    : config.assigneePolicy === 'named_users'
      ? (config.assigneeIds ?? [])
      : directory.roles.find((role) => role.id === config.roleId)?.memberIds ?? []
  const assignees = [...new Set(configured.filter((id) => enabledUsers.has(id)))]
  if (assignees.length === 0) throw new Error('审批策略未解析到任何启用的审批人')
  return assignees
}
