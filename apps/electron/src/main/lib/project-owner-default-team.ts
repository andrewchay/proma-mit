import templates from '../../../resources/employee-role-templates.json'
import { listProjectWorkspaceBindings } from './project-workspace-bindings'
import * as store from './project-sqlite-store'

const REVIEWER_ROLE = 'delivery-verifier'

/** 按当前方案在项目已授权工作区内补齐岗位实例；不扩大资料范围或启用高权限工具。 */
export function ensureOwnerDefaultTeam(projectId: string, binding: { carrierId: string; workspaceId: string; channelId: string; modelId: string }, roleKeys: string[]): void {
  if (listProjectWorkspaceBindings(projectId).length !== 1) return
  const wanted = [...new Set([...roleKeys, REVIEWER_ROLE])]
  const existing = store.listAgentEmployees()
  // 老项目已有业务团队时尊重其配置；新建的 Owner 专用工作区才按方案自动落位默认岗位。
  if (existing.some((employee) => employee.id !== binding.carrierId
    && (employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : [])).includes(binding.workspaceId))) return
  for (const roleKey of wanted) {
    const template = templates.find((item) => item.id === roleKey)
    if (!template || existing.some((employee) => employee.enabled && employee.roleTemplateId === roleKey
      && employee.id !== binding.carrierId
      && (employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : [])).includes(binding.workspaceId))) continue
    const employee = store.createAgentEmployee({
      name: `项目员工 · ${template.name}`,
      role: template.role,
      roleTemplateId: template.id,
      description: template.description,
      systemPrompt: template.systemPrompt,
      runtime: 'ai-sdk',
      channelId: binding.channelId,
      modelId: binding.modelId,
      workspaceIds: [binding.workspaceId],
      executionProfile: 'controlled',
      permissionMode: 'safe',
    })
    existing.push(employee)
  }
}
