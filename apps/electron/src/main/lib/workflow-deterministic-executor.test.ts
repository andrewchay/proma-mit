import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from '@proma/shared'
import { createAgentWorkspace } from './agent-workspace-manager'
import { createWorkflowRun, publishWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'
import { executeWorkflowDeterministicNode } from './workflow-deterministic-executor'

const TEST_DIR = '/tmp/paa-workflow-deterministic-test'

function draft(workspaceId: string, expression = '$input.amount >= 100'): WorkflowDefinition {
  const now = Date.now()
  return {
    format: WORKFLOW_FORMAT, formatVersion: '1.0', id: 'deterministic-review', workspaceId, name: '确定性节点', status: 'draft', version: '0.1.0', trigger: { kind: 'manual' },
    nodes: [
      { id: 'start', kind: 'start', title: '开始' },
      { id: 'prepare', kind: 'transform', title: '准备数据', config: { assignments: { project: '$input.projectId', nested: { amount: '$input.amount' } } } },
      { id: 'gate', kind: 'condition', title: '金额判断', config: { expression } },
      { id: 'yes', kind: 'transform', title: '通过', config: { assignments: { approved: true } } },
      { id: 'no', kind: 'transform', title: '拒绝', config: { assignments: { approved: false } } },
      { id: 'end', kind: 'end', title: '结束' },
    ],
    edges: [
      { id: 'start-prepare', from: 'start', to: 'prepare' }, { id: 'prepare-gate', from: 'prepare', to: 'gate' },
      { id: 'gate-yes', from: 'gate', to: 'yes', label: 'true' }, { id: 'gate-no', from: 'gate', to: 'no', label: 'false' },
      { id: 'yes-end', from: 'yes', to: 'end' }, { id: 'no-end', from: 'no', to: 'end' },
    ],
    layout: { nodes: Object.fromEntries(['start', 'prepare', 'gate', 'yes', 'no', 'end'].map((id, index) => [id, { x: index * 120, y: 0 }])) }, createdAt: now, updatedAt: now,
  }
}

function createRun(expression?: string) {
  const workspace = createAgentWorkspace('确定性节点工作区')
  const definition = draft(workspace.id, expression)
  saveWorkflowDefinition(definition)
  publishWorkflowDefinition(definition.id, { version: '1.0.0' })
  return createWorkflowRun(definition.id, { projectId: 'p-1', amount: 120 })
}

describe('Workflow 确定性节点执行器', () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR; rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test('Given transform 与 true/false 分支 When 执行 Then 安全解析引用并只推进选中分支', () => {
    const run = createRun()
    const transformed = executeWorkflowDeterministicNode('deterministic-review', run.id, 'prepare')
    expect(transformed.nodeRuns?.prepare?.output).toEqual({ project: 'p-1', nested: { amount: 120 } })
    expect(transformed.nodeRuns?.gate?.status).toBe('ready')

    const gated = executeWorkflowDeterministicNode('deterministic-review', run.id, 'gate')
    expect(gated.nodeRuns?.gate?.output).toEqual({ result: true })
    expect(gated.nodeRuns?.yes?.status).toBe('ready')
    expect(gated.nodeRuns?.no?.status).toBe('skipped')
  })

  test('Given an unsupported condition expression When executed Then the node fails with an audit-visible error', () => {
    const run = createRun('process.exit(1)')
    executeWorkflowDeterministicNode('deterministic-review', run.id, 'prepare')
    const failed = executeWorkflowDeterministicNode('deterministic-review', run.id, 'gate')
    expect(failed.nodeRuns?.gate?.status).toBe('failed')
    expect(failed.nodeRuns?.gate?.error?.code).toBe('deterministic_execution_failed')
  })
})
