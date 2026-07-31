import type { WorkspaceCapabilities } from './types/agent'
import type { WorkflowDefinition, WorkflowNode } from './types/workflow'

/** Workflow 发布前的能力预检错误。 */
export interface WorkflowCapabilityViolation {
  nodeId: string
  capability: 'skill' | 'mcp' | 'tool' | 'permission_profile'
  name: string
  reason: 'missing' | 'disabled' | 'version_mismatch' | 'unsupported'
}

/**
 * 校验工作流节点引用的能力是否确实存在于所属工作区。
 *
 * 此函数只判断“能否发布”；执行器仍必须按照 capabilityPolicy 做最小权限过滤。
 */
export function validateWorkflowCapabilities(
  definition: Pick<WorkflowDefinition, 'nodes'>,
  capabilities: WorkspaceCapabilities,
  supportedPermissionProfileIds: readonly string[] = [],
): WorkflowCapabilityViolation[] {
  const violations: WorkflowCapabilityViolation[] = []
  const skills = new Map(capabilities.skills.map((skill) => [skill.slug, skill]))
  const mcpServers = new Map(capabilities.mcpServers.map((server) => [server.name, server]))

  for (const node of definition.nodes) {
    validateNodeCapabilities(node, skills, mcpServers, supportedPermissionProfileIds, violations)
  }
  return violations
}

function validateNodeCapabilities(
  node: WorkflowNode,
  skills: Map<string, WorkspaceCapabilities['skills'][number]>,
  mcpServers: Map<string, WorkspaceCapabilities['mcpServers'][number]>,
  supportedPermissionProfileIds: readonly string[],
  violations: WorkflowCapabilityViolation[],
): void {
  const policy = node.capabilityPolicy
  if (node.kind === 'tool') {
    const toolName = (node.config as { toolName?: unknown } | undefined)?.toolName
    const allowedTools = policy?.allowedTools ?? []
    if (typeof toolName !== 'string' || !allowedTools.includes(toolName)) {
      violations.push({ nodeId: node.id, capability: 'tool', name: typeof toolName === 'string' ? toolName : 'unknown', reason: 'missing' })
    }
  }
  if (!policy) return

  for (const reference of policy.skills ?? []) {
    const skill = skills.get(reference.slug)
    if (!skill) {
      violations.push({ nodeId: node.id, capability: 'skill', name: reference.slug, reason: 'missing' })
    } else if (!skill.enabled) {
      violations.push({ nodeId: node.id, capability: 'skill', name: reference.slug, reason: 'disabled' })
    } else if (reference.version && skill.version !== reference.version) {
      violations.push({ nodeId: node.id, capability: 'skill', name: reference.slug, reason: 'version_mismatch' })
    }
  }

  for (const reference of policy.mcpServers ?? []) {
    const server = mcpServers.get(reference.name)
    if (!server) {
      violations.push({ nodeId: node.id, capability: 'mcp', name: reference.name, reason: 'missing' })
    } else if (!server.enabled) {
      violations.push({ nodeId: node.id, capability: 'mcp', name: reference.name, reason: 'disabled' })
    }
  }

  if (policy.permissionProfileId && !supportedPermissionProfileIds.includes(policy.permissionProfileId)) {
    violations.push({ nodeId: node.id, capability: 'permission_profile', name: policy.permissionProfileId, reason: 'unsupported' })
  }
}
