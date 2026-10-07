/** 非代码受控员工：明确绑定，不继承旧版全自动权限或全局回退。 */
interface ControlledEmployeeConfiguration {
  runtime?: string
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceIds?: string[]
  workflowId?: string
  permissionMode?: string
}
interface ControlledTargetFacts {
  getChannel(id: string): { enabled: boolean; models: Array<{ id: string; enabled: boolean }> } | undefined
  getWorkspace(id: string): object | undefined
}
function boundWorkspaces(input: ControlledEmployeeConfiguration): string[] {
  return input.workspaceIds ?? (input.workspaceId ? [input.workspaceId] : [])
}
export function validateControlledConfiguration(input: ControlledEmployeeConfiguration, facts: ControlledTargetFacts): void {
  if (!['pi', 'ai-sdk'].includes(input.runtime ?? 'ai-sdk')) throw new Error('受控员工请选择 Pi 或 AI SDK Runtime')
  if (input.workflowId) throw new Error('受控员工暂不支持 Workflow，不能绕过当前任务权限')
  if (!['safe', 'auto'].includes(input.permissionMode ?? 'safe')) throw new Error('受控员工只允许 safe 或 auto，不允许绕过审批')
  const ids = boundWorkspaces(input)
  if (!ids.length) throw new Error('受控员工至少需要选择一个执行工作区（托管或本地）')
  if (new Set(ids).size !== ids.length || ids.some((id) => !id || !facts.getWorkspace(id))) throw new Error('受控员工工作区不存在、为空或重复，请重新选择')
  const channel = facts.getChannel(input.channelId)
  if (!channel?.enabled) throw new Error('受控员工渠道不存在或已停用')
  if (!input.modelId?.trim() || !channel.models.some((model) => model.id === input.modelId?.trim() && model.enabled)) throw new Error('请显式选择已启用的模型，不使用隐式回退')
}
export function validateControlledTarget(input: ControlledEmployeeConfiguration, taskWorkspaceId: string | undefined, facts: ControlledTargetFacts): { workspaceId: string; modelId: string; permissionMode: 'safe' | 'auto' } {
  validateControlledConfiguration(input, facts)
  const ids = boundWorkspaces(input)
  if (taskWorkspaceId && !ids.includes(taskWorkspaceId)) throw new Error('任务工作区不在该受控员工的绑定范围内')
  const workspaceId = taskWorkspaceId ?? (ids.length === 1 ? ids[0] : undefined)
  if (!workspaceId) throw new Error('受控员工有多个工作区，请在任务中明确选择执行工作区')
  return { workspaceId, modelId: input.modelId!.trim(), permissionMode: input.permissionMode === 'auto' ? 'auto' : 'safe' }
}
