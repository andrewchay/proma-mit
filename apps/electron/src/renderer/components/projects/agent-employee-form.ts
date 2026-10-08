import type { AgentEmployeeResult } from '@gravitas/shared'
export interface EmployeeRoleTemplate { id: string; version: string; name: string; role: string; description: string; systemPrompt: string }
interface EmployeeForm { name: string; runtime: string; channelId: string; modelId: string; workspaceIds: string[]; executionProfile: NonNullable<AgentEmployeeResult['executionProfile']>; permissionMode: string; workflowId: string }
interface WorkspaceOption { id: string; name: string; rootPath?: string }
interface ChannelOption { id: string; models?: Array<{ id: string; enabled: boolean }> }
export function isEmployeeWorkspaceEligible(profile: EmployeeForm['executionProfile'], workspace: WorkspaceOption): boolean {
  return profile !== 'development' || Boolean(workspace.rootPath)
}
/** 表单仅解释保存配置所需信息，不构成派发或授权门禁。 */
export function getEmployeeSaveIssues(form: EmployeeForm, channels: ChannelOption[], workspaces: WorkspaceOption[]): string[] {
  const issues: string[] = []
  if (!form.name.trim()) issues.push('请填写员工名称。')
  const channel = channels.find((item) => item.id === form.channelId)
  if (!channel) issues.push('请选择可用渠道；没有渠道时请先到设置中配置。')
  if (form.executionProfile !== 'general') {
    if (!form.modelId.trim() || (channel && !channel.models?.some((model) => model.id === form.modelId.trim() && model.enabled))) issues.push('请填写该渠道中已启用的模型 ID。')
    if (!form.workspaceIds.length) issues.push(form.executionProfile === 'development' ? '研发员工请选择本地 Git 工作区；非代码岗位请改选「非代码受控员工」。' : '请选择至少一个执行工作区，托管或本地工作区均可。')
    if (form.workspaceIds.some((id) => !workspaces.some((space) => space.id === id && isEmployeeWorkspaceEligible(form.executionProfile, space)))) issues.push('已选工作区失效或不符合研发配置，请取消该项并重新选择。')
    if (form.workflowId) issues.push('受控/研发员工不能绑定 Workflow，请取消绑定。')
    if (!['safe', 'auto'].includes(form.permissionMode)) issues.push('权限只能选择只读或审批执行，不能绕过审批。')
    if (form.executionProfile === 'controlled' && !['pi', 'ai-sdk'].includes(form.runtime)) issues.push('非代码受控员工请选择 Pi 或 AI SDK Runtime。')
  }
  return issues
}
export function employeeTemplateChanges(template: EmployeeRoleTemplate) {
  return { name: template.name, role: template.role, description: template.description, systemPrompt: template.systemPrompt, executionProfile: 'controlled' as const, permissionMode: 'safe' as const, workflowId: '' }
}
