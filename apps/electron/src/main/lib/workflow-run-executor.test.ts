import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from '@proma/shared'
import { createAgentWorkspace } from './agent-workspace-manager'
import { createWorkflowRun, publishWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'
import { executeWorkflowRun } from './workflow-run-executor'

const TEST_DIR = '/tmp/paa-workflow-run-executor-test'

function definition(workspaceId: string): WorkflowDefinition {
  const now = Date.now()
  return {
    format: WORKFLOW_FORMAT, formatVersion: '1.0', id: 'run-executor', workspaceId, name: 'Run 执行器', status: 'draft', version: '0.1.0', trigger: { kind: 'manual' },
    nodes: [
      { id: 'start', kind: 'start', title: '开始' },
      { id: 'prepare', kind: 'transform', title: '准备', config: { assignments: { project: '$input.projectId' } } },
      { id: 'approval', kind: 'approval', title: '审批', config: { assigneePolicy: 'workflow_owner', onTimeout: 'fail' } },
      { id: 'end', kind: 'end', title: '结束' },
    ],
    edges: [{ id: 'start-prepare', from: 'start', to: 'prepare' }, { id: 'prepare-approval', from: 'prepare', to: 'approval' }, { id: 'approval-end', from: 'approval', to: 'end' }],
    layout: { nodes: { start: { x: 0, y: 0 }, prepare: { x: 100, y: 0 }, approval: { x: 200, y: 0 }, end: { x: 300, y: 0 } } }, createdAt: now, updatedAt: now,
  }
}

describe('Workflow Run 调度器', () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR; rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test('Given transform 后紧接审批 When 推进 Run Then 自动完成确定性节点并停在审批', async () => {
    const workspace = createAgentWorkspace('Run 执行器工作区')
    const draft = definition(workspace.id)
    saveWorkflowDefinition(draft)
    publishWorkflowDefinition(draft.id, { version: '1.0.0' })
    const run = createWorkflowRun(draft.id, { projectId: 'p-1' })
    const progressed = await executeWorkflowRun(draft.id, run.id, 'unused-channel')
    expect(progressed.status).toBe('waiting_approval')
    expect(progressed.nodeRuns?.prepare?.output).toEqual({ project: 'p-1' })
    expect(progressed.nodeRuns?.approval?.status).toBe('waiting_approval')
  })
})
