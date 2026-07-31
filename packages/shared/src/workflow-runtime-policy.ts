import type { WorkflowCapabilityPolicy } from './types/workflow'

/** Workflow 运行时的硬上限判定；MCP 仅按已冻结服务器名授权。 */
export function isWorkflowToolAllowed(toolName: string, policy: WorkflowCapabilityPolicy, mcpServerNames: string[]): boolean {
  if ((policy.allowedTools ?? []).includes(toolName)) return true
  if (!toolName.startsWith('mcp__')) return false
  const serverName = toolName.slice('mcp__'.length).split('__')[0]
  return Boolean(serverName && mcpServerNames.includes(serverName))
}
