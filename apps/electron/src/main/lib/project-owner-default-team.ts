import templates from '../../../resources/employee-role-templates.json'
import { listProjectWorkspaceBindings } from './project-workspace-bindings'
import * as store from './project-sqlite-store'
import { getOwnerRuntimeCarrierIds } from './project-owner-runtime-binding'
import { getAgentWorkspace } from './agent-workspace-manager'
import { isGitRepositoryWithHead } from './project-owner-dev-workspace'
import { getConfigDir } from './config-paths'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'

const REVIEWER_ROLE = 'delivery-verifier'

/** 按当前方案在项目已授权工作区内补齐岗位实例；不扩大资料范围或启用高权限工具。 */
export function ensureOwnerDefaultTeam(projectId: string, binding: { carrierId: string; workspaceId: string; channelId: string; modelId: string }, roleKeys: string[], requiresDevelopment = false): boolean {
  if (listProjectWorkspaceBindings(projectId).length !== 1) return false
  const wanted = [...new Set(roleKeys)].map(roleKey => ({ roleKey, reviewer: false }))
  // 方案自身可能包含交付核验步骤，最终独立评审必须另有一人。
  wanted.push({ roleKey: REVIEWER_ROLE, reviewer: true })
  const definitions = new Map(templates.map(template => [template.id, template]))
  if (wanted.some(({ roleKey }) => !definitions.has(roleKey))) return false
  const ownerIds = getOwnerRuntimeCarrierIds()
  let created = false
  const existing = store.listAgentEmployees().filter(employee => employee.id !== binding.carrierId && !ownerIds.has(employee.id)
    && (employee.workspaceIds ?? (employee.workspaceId ? [employee.workspaceId] : [])).includes(binding.workspaceId))
  if (existing.length && !requiresDevelopment) return false
  // 工作区具备 Git 基线时提供研发员工，安排阶段才能选择 development 执行方式产出真实文件与运行证据；
  // 研发员工经冻结来源核验后可被收紧为受控文本调用，两种执行方式都可用。
  const workspace = getAgentWorkspace(binding.workspaceId)
  const rootPath = workspace?.rootPath
  const nameFor = (template: typeof templates[number], reviewer: boolean) => `${reviewer ? '项目独立评审' : '项目员工'} · ${template.name}`
  // 只在应用受管的专用仓库补齐旧版默认团队。已有用户团队及其他项目工作区延续原配置。
  const mayRepairDefaultTeam = rootPath && workspace
    && resolve(rootPath) === resolve(realpathSync(getConfigDir()), 'owner-dev-repos', workspace.slug)
    && existing.every(employee => {
      const template = employee.roleTemplateId && definitions.get(employee.roleTemplateId)
      return template && employee.enabled && employee.permissionMode === 'safe' && employee.runtime === 'ai-sdk'
        && employee.channelId === binding.channelId && employee.modelId === binding.modelId && employee.workspaceIds?.length === 1
        && employee.role === template.role && employee.description === template.description && employee.systemPrompt === template.systemPrompt
        && !employee.skills?.length && !employee.workflowId
        && (employee.name === nameFor(template, false) || employee.name === nameFor(template, true))
    })
  if (existing.length && !mayRepairDefaultTeam) return false
  const missing = wanted.filter(({ roleKey, reviewer }) => !existing.some(employee => employee.roleTemplateId === roleKey
    && employee.name === nameFor(definitions.get(roleKey)!, reviewer) && employee.executionProfile === 'development'))
  if (!missing.length) return false
  const developmentReady = Boolean(rootPath && isGitRepositoryWithHead(rootPath))
  // 文件交付遇到 Git 暂不可用时，不能先登记一批不符合该方案的受控文本员工。
  if (requiresDevelopment && !developmentReady) return false
  for (const { roleKey, reviewer } of missing) {
    const template = definitions.get(roleKey)!
    const name = nameFor(template, reviewer)
    store.createAgentEmployee({
      name,
      role: template.role,
      roleTemplateId: template.id,
      description: template.description,
      systemPrompt: template.systemPrompt,
      runtime: 'ai-sdk',
      channelId: binding.channelId,
      modelId: binding.modelId,
      workspaceIds: [binding.workspaceId],
      executionProfile: developmentReady ? 'development' : 'controlled',
      permissionMode: 'safe',
    })
    created = true
  }
  return created
}
