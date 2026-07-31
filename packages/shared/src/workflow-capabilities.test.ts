import { describe, expect, test } from 'bun:test'
import { validateWorkflowCapabilities } from './workflow-capabilities'
import type { WorkflowDefinition, WorkspaceCapabilities } from './index'

const capabilities: WorkspaceCapabilities = {
  skills: [
    { slug: 'project-review', name: '项目复盘', version: '1.0.0', enabled: true },
    { slug: 'disabled-skill', name: '已禁用', version: '1.0.0', enabled: false },
  ],
  mcpServers: [
    { name: 'nocobase', type: 'http', enabled: true },
    { name: 'disabled-mcp', type: 'stdio', enabled: false },
  ],
}

function definitionWithPolicy(): Pick<WorkflowDefinition, 'nodes'> {
  return {
    nodes: [{
      id: 'collect',
      kind: 'agent',
      title: '收集',
      config: { prompt: '收集信息' },
      capabilityPolicy: {
        skills: [{ slug: 'project-review', version: '1.0.0' }],
        mcpServers: [{ name: 'nocobase' }],
        permissionProfileId: 'workflow-readonly',
      },
    }],
  }
}

describe('Workflow 能力预检', () => {
  test('Given 工作区已启用能力 When 发布前预检 Then 通过', () => {
    expect(validateWorkflowCapabilities(definitionWithPolicy(), capabilities, ['workflow-readonly'])).toEqual([])
  })

  test('Given 缺失、禁用或版本不匹配能力 When 预检 Then 返回精确节点级错误', () => {
    const definition = definitionWithPolicy()
    definition.nodes[0]!.capabilityPolicy = {
      skills: [
        { slug: 'missing-skill' },
        { slug: 'disabled-skill' },
        { slug: 'project-review', version: '2.0.0' },
      ],
      mcpServers: [{ name: 'missing-mcp' }, { name: 'disabled-mcp' }],
      permissionProfileId: 'unknown-profile',
    }

    expect(validateWorkflowCapabilities(definition, capabilities, ['workflow-readonly'])).toEqual([
      { nodeId: 'collect', capability: 'skill', name: 'missing-skill', reason: 'missing' },
      { nodeId: 'collect', capability: 'skill', name: 'disabled-skill', reason: 'disabled' },
      { nodeId: 'collect', capability: 'skill', name: 'project-review', reason: 'version_mismatch' },
      { nodeId: 'collect', capability: 'mcp', name: 'missing-mcp', reason: 'missing' },
      { nodeId: 'collect', capability: 'mcp', name: 'disabled-mcp', reason: 'disabled' },
      { nodeId: 'collect', capability: 'permission_profile', name: 'unknown-profile', reason: 'unsupported' },
    ])
  })

  test('Given tool 节点未在最小权限列表声明 When 发布前预检 Then 拒绝该节点', () => {
    const definition: Pick<WorkflowDefinition, 'nodes'> = {
      nodes: [{ id: 'read', kind: 'tool', title: '读取', config: { toolName: 'Read' }, capabilityPolicy: { allowedTools: [] } }],
    }
    expect(validateWorkflowCapabilities(definition, capabilities, ['workflow-readonly'])).toEqual([
      { nodeId: 'read', capability: 'tool', name: 'Read', reason: 'missing' },
    ])
  })
})
