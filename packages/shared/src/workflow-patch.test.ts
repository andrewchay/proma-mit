import { describe, expect, test } from 'bun:test'
import { applyWorkflowPatches } from './workflow-patch'
import type { WorkflowDefinition } from './types/workflow'

function definition(): WorkflowDefinition {
  return { format: 'paa.workflow', formatVersion: '1.0', id: 'review-flow', workspaceId: 'workspace-1', name: 'Review', status: 'draft', version: '0.1.0', trigger: { kind: 'manual' }, nodes: [{ id: 'start', kind: 'start', title: 'Start' }, { id: 'end', kind: 'end', title: 'End' }], edges: [{ id: 'start-end', from: 'start', to: 'end' }], layout: { nodes: { start: { x: 0, y: 0 }, end: { x: 200, y: 0 } } }, createdAt: 1, updatedAt: 1 }
}

describe('Workflow patch protocol', () => {
  test('given an assistant patch, when it adds a node and rewires the graph, then it returns a valid DSL', () => {
    const result = applyWorkflowPatches(definition(), [
      { op: 'remove_edge', edgeId: 'start-end' },
      { op: 'add_node', node: { id: 'review', kind: 'approval', title: 'Review', config: { assigneePolicy: 'workflow_owner', onTimeout: 'fail' } }, position: { x: 100, y: 0 } },
      { op: 'add_edge', edge: { id: 'start-review', from: 'start', to: 'review' } },
      { op: 'add_edge', edge: { id: 'review-end', from: 'review', to: 'end' } },
    ])
    expect(result.nodes.map((node) => node.id)).toEqual(['start', 'end', 'review'])
  })

  test('given a patch that removes start, when applied, then it is rejected', () => {
    expect(() => applyWorkflowPatches(definition(), [{ op: 'remove_node', nodeId: 'start' }])).toThrow('不能删除')
  })

  test('given a valid schedule trigger patch, when applied, then it keeps the trigger in the validated DSL', () => {
    const result = applyWorkflowPatches(definition(), [{ op: 'set_trigger', trigger: { kind: 'schedule', config: { mode: 'interval', interval: 30, channelId: 'channel-1' } } }])
    expect(result.trigger.kind).toBe('schedule')
  })
})
