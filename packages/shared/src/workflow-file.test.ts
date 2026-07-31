import { describe, expect, test } from 'bun:test'
import { exportWorkflowDefinition, importWorkflowDefinition, migrateWorkflowDefinition } from './workflow-file'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from './types/workflow'

function definition(): WorkflowDefinition {
  return {
    format: WORKFLOW_FORMAT, formatVersion: '1.0', id: 'source', workspaceId: 'source-workspace', name: '可移植流程', status: 'published', version: '2.0.0',
    trigger: { kind: 'manual' }, nodes: [{ id: 'start', kind: 'start', title: '开始' }, { id: 'end', kind: 'end', title: '结束' }],
    edges: [{ id: 'start-end', from: 'start', to: 'end' }], layout: { nodes: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 } } },
    publication: { version: '2.0.0', publishedAt: 1 }, createdAt: 1, updatedAt: 1,
  }
}

describe('Workflow 文件格式', () => {
  test('导入发布文件时创建目标工作区的独立草稿，不继承发布权限', () => {
    const file = exportWorkflowDefinition(definition(), 10)
    const imported = importWorkflowDefinition(file, { workspaceId: 'target-workspace', workflowId: 'copied', now: 20 })
    expect(imported.workspaceId).toBe('target-workspace')
    expect(imported.id).toBe('copied')
    expect(imported.status).toBe('draft')
    expect(imported.publication).toBeUndefined()
  })

  test('仅迁移明确支持的 0.9 格式，未知版本拒绝导入', () => {
    const legacy = { ...definition(), formatVersion: '0.9' }
    expect(migrateWorkflowDefinition(legacy).formatVersion).toBe('1.0')
    expect(() => migrateWorkflowDefinition({ ...definition(), formatVersion: '9.0' })).toThrow('不支持的 Workflow 格式版本')
  })

  test('导出或导入包含凭证时被 DSL 校验拒绝', () => {
    expect(() => exportWorkflowDefinition({ ...definition(), description: 'ok', inputSchema: { apiKey: 'secret' } })).toThrow('不得存储凭证')
  })
})
