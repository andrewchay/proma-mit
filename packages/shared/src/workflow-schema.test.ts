import { describe, expect, test } from 'bun:test'
import { WORKFLOW_FORMAT } from './index'
import { validateWorkflowDefinition } from './workflow-runtime'

interface WorkflowFixture {
  nodes: Array<{ id: string; kind: string; title: string; config?: Record<string, unknown> }>
  edges: Array<{ id: string; from: string; to: string }>
  [key: string]: unknown
}

function createValidDefinition(): WorkflowFixture {
  return {
    format: WORKFLOW_FORMAT,
    formatVersion: '1.0',
    id: 'project-risk-review',
    workspaceId: 'workspace-product',
    name: '项目风险周报',
    status: 'draft',
    version: '0.1.0',
    trigger: { kind: 'manual' },
    nodes: [
      { id: 'start', kind: 'start', title: '开始' },
      { id: 'collect', kind: 'agent', title: '收集风险', config: { prompt: '收集项目风险' } },
      { id: 'approval', kind: 'approval', title: '负责人确认', config: { assigneePolicy: 'workflow_owner', onTimeout: 'fail' } },
      { id: 'end', kind: 'end', title: '结束' },
    ],
    edges: [
      { id: 'start-collect', from: 'start', to: 'collect' },
      { id: 'collect-approval', from: 'collect', to: 'approval' },
      { id: 'approval-end', from: 'approval', to: 'end' },
    ],
    layout: { nodes: { start: { x: 0, y: 0 }, collect: { x: 160, y: 0 }, approval: { x: 320, y: 0 }, end: { x: 480, y: 0 } } },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('WorkflowDefinitionSchema', () => {
  test('接受包含 Agent 与审批节点的最小 DAG', () => {
    expect(validateWorkflowDefinition(createValidDefinition()).success).toBe(true)
  })

  test('拒绝重复节点 ID 与环', () => {
    const workflow = createValidDefinition()
    workflow.nodes.push({ id: 'collect', kind: 'transform', title: '重复节点', config: { assignments: {} } })
    workflow.edges.push({ id: 'end-start', from: 'end', to: 'start' })

    const result = validateWorkflowDefinition(workflow)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join('\n')).toContain('节点 ID 重复')
      expect(result.error.issues.map((issue) => issue.message).join('\n')).toContain('无环 DAG')
    }
  })

  test('拒绝 Definition 中的凭证', () => {
    const workflow = createValidDefinition()
    workflow.nodes[1]!.config = { prompt: '收集项目风险', apiKey: 'sk-secret-token' }

    const result = validateWorkflowDefinition(workflow)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join('\n')).toContain('不得存储凭证')
    }
  })
})
