import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_RUNTIME_CAPABILITIES } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getChannelById } from './channel-manager'
import { getAgentEmployee, getProject } from './project-sqlite-store'
import { getPilotPolicy, type PilotPolicy } from './project-pilot-policy'
import type { AgentEmployee } from './project-types'

export interface PilotReadiness {
  projectId: string
  policyRevision: number | null
  bindingsValid: boolean
  blockers: string[]
}

interface PilotBindingFacts {
  projectExists: boolean
  workspace: { rootPath?: string } | undefined
  gitMarkerExists: boolean
  channel: { enabled: boolean; models: Array<{ id: string; enabled: boolean }> } | undefined
  employees: Array<AgentEmployee | null>
}

/** 每次预检都重新读取绑定。结果仅供配置审查，不是授权或派发许可。 */
export function inspectPilotReadiness(projectId: string, now = Date.now()): PilotReadiness {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目 ID')
  const policy = getPilotPolicy(projectId)
  const workspace = policy ? getAgentWorkspace(policy.workspaceId) : undefined
  return evaluatePilotPolicyBindings(projectId, policy, {
    projectExists: Boolean(getProject(projectId)),
    workspace,
    gitMarkerExists: Boolean(workspace?.rootPath && existsSync(join(workspace.rootPath, '.git'))),
    channel: policy ? getChannelById(policy.channelId) : undefined,
    employees: policy ? policy.employeeIds.map(getAgentEmployee) : [],
  }, now)
}

/** 纯校验便于覆盖旧 bypass、错工作区和失效绑定；不能作为激活凭据。 */
export function evaluatePilotPolicyBindings(projectId: string, policy: PilotPolicy | null, facts: PilotBindingFacts, now: number): PilotReadiness {
  const blockers: string[] = []
  if (!facts.projectExists) blockers.push('项目不存在')
  if (policy && policy.projectId !== projectId) blockers.push('策略草案与项目不匹配')
  if (!policy) blockers.push('尚未保存 Pilot 策略草案')
  else checkPolicyBindings(policy, facts, now, blockers)
  return { projectId, policyRevision: policy?.revision ?? null, bindingsValid: blockers.length === 0, blockers }
}

function checkPolicyBindings(policy: PilotPolicy, facts: PilotBindingFacts, now: number, blockers: string[]): void {
  if (policy.expiresAt <= now) blockers.push('策略草案已过期')
  const workspace = facts.workspace
  if (!workspace) blockers.push('执行工作区不存在')
  else if (!workspace.rootPath || !facts.gitMarkerExists) blockers.push('首版研发 Pilot 需要可用的本地 Git 工作区')

  const channel = facts.channel
  if (!channel?.enabled) blockers.push('渠道不存在或已停用')
  else if (!channel.models.some((model) => model.id === policy.modelId && model.enabled)) blockers.push('模型不存在或已停用')

  if (policy.employeeIds.length < 2) blockers.push('首版至少需要执行者与技术评审者两名员工')
  if (!policy.executorEmployeeId || !policy.reviewerEmployeeId
    || policy.executorEmployeeId === policy.reviewerEmployeeId
    || !policy.employeeIds.includes(policy.executorEmployeeId)
    || !policy.employeeIds.includes(policy.reviewerEmployeeId)) {
    blockers.push('必须明确绑定不同的执行员工与技术评审员工')
  }
  for (const [index, employeeId] of policy.employeeIds.entries()) {
    const employee = facts.employees[index]
    if (!employee?.enabled || employee.id !== employeeId) { blockers.push(`员工 ${employeeId} 不存在或已停用`); continue }
    if (employee.executionProfile !== 'development' || employee.workflowId || !['proma', 'ai-sdk'].includes(employee.runtime)
      || (employee.permissionMode ?? 'safe') !== 'safe') {
      blockers.push(`员工 ${employeeId} 不适用于首版安全研发运行路径`)
    }
    if (!AGENT_RUNTIME_CAPABILITIES[employee.runtime].supportsBudgetStopThreshold) {
      blockers.push(`员工 ${employeeId} 的 Runtime 不支持 Pilot 单次费用超额停止阈值`)
    }
    const allowedWorkspaces = employee.workspaceIds?.length ? employee.workspaceIds : employee.workspaceId ? [employee.workspaceId] : []
    if (!allowedWorkspaces.includes(policy.workspaceId)) blockers.push(`员工 ${employeeId} 未绑定执行工作区`)
    if (employee.channelId !== policy.channelId || employee.modelId !== policy.modelId) {
      blockers.push(`员工 ${employeeId} 的渠道或模型与策略草案不一致`)
    }
  }
}
