/** Owner业务调用可收紧已有普通员工；不持久化改档、不进入普通员工启动路径。 */
import type { AgentEmployee } from './project-types'
import { validateControlledTarget } from './agent-controlled-context'
import { getChannelById } from './channel-manager'
import { getAgentWorkspace } from './agent-workspace-manager'
import type { OwnerExecutionPreparationSource } from '@gravitas/shared'
import { ownerEmployeePriceProviderKind } from './project-owner-employee-runtime'

export function ownerControlledEmployee(employee: AgentEmployee): AgentEmployee {
  if (!['general', 'development'].includes(employee.executionProfile ?? 'general') || !['ai-sdk', 'pi'].includes(employee.runtime) || employee.workflowId) throw new Error('当前员工尚不兼容Owner受控调用')
  const channel = getChannelById(employee.channelId)
  if (!channel || !employee.modelId) throw new Error('Owner员工渠道或模型不可用')
  ownerEmployeePriceProviderKind(employee.runtime, channel.provider, employee.modelId)
  return { ...employee, executionProfile: 'controlled', permissionMode: 'safe' }
}
export function canUseOwnerControlledEmployee(employee: AgentEmployee, workspaceId: string): boolean {
  try { validateControlledTarget(ownerControlledEmployee(employee), workspaceId, { getChannel: getChannelById, getWorkspace: getAgentWorkspace }); return true }
  catch { return false }
}
/** 只接受权威重验证来源内明确冻结的普通员工收紧记录。 */
export function resolveOwnerEmployeeInvocation(employee: AgentEmployee, source: Pick<OwnerExecutionPreparationSource, 'employeeInvocations'> & { executionKind: string }): AgentEmployee {
  if (employee.executionProfile === source.executionKind) return employee
  const frozen = source.employeeInvocations?.find(item => item.employeeId === employee.id)
  if (source.executionKind !== 'controlled' || !frozen || frozen.originalProfile !== (employee.executionProfile ?? 'general') || !['general', 'development'].includes(frozen.originalProfile) || frozen.executionProfile !== 'controlled' || frozen.permissionMode !== 'safe') throw new Error('Owner员工调用方式与冻结来源不匹配')
  return ownerControlledEmployee(employee)
}
