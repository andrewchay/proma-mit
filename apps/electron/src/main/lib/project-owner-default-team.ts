import templates from '../../../resources/employee-role-templates.json'
import { listProjectWorkspaceBindings } from './project-workspace-bindings'
import * as store from './project-sqlite-store'
import { getOwnerRuntimeCarrierIds } from './project-owner-runtime-binding'

const REVIEWER_ROLE = 'delivery-verifier'

/** 按当前方案在项目已授权工作区内补齐岗位实例；不扩大资料范围或启用高权限工具。 */
export function ensureOwnerDefaultTeam(projectId: string, binding: { carrierId: string; workspaceId: string; channelId: string; modelId: string }, roleKeys: string[]): boolean {
  if (listProjectWorkspaceBindings(projectId).length !== 1) return false
  const wanted = [...new Set(roleKeys)].map(roleKey => ({ roleKey, reviewer: false }))
  // 方案自身可能包含交付核验步骤，最终独立评审必须另有一人。
  wanted.push({ roleKey: REVIEWER_ROLE, reviewer: true })
  const definitions = new Map(templates.map(template => [template.id, template]))
  if (wanted.some(({ roleKey }) => !definitions.has(roleKey))) return false
  const existing = store.listAgentEmployees()
  const ownerIds = getOwnerRuntimeCarrierIds()
  let created = false
  // 老项目已有业务团队时尊重其配置；新建的 Owner 专用工作区才按方案自动落位默认岗位。
  if (existing.some((employee) => employee.id !== binding.carrierId && !ownerIds.has(employee.id)
    && (employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : [])).includes(binding.workspaceId))) return false
  for (const { roleKey, reviewer } of wanted) {
    const template = definitions.get(roleKey)!
    store.createAgentEmployee({
      name: `${reviewer ? '项目独立评审' : '项目员工'} · ${template.name}`,
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
    created = true
  }
  return created
}
