import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from '@gravitas/shared'
import { createAgentWorkspace } from './agent-workspace-manager'
import { publishWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'
import { triggerWorkflowEvent } from './workflow-event-service'

const TEST_DIR = '/tmp/paa-workflow-event-test'

function eventDefinition(workspaceId: string): WorkflowDefinition {
  const now = Date.now()
  return {
    format: WORKFLOW_FORMAT, formatVersion: '1.0', id: 'event-flow', workspaceId, name: '事件流程', status: 'draft', version: '0.1.0',
    trigger: { kind: 'event', config: { eventName: 'project.updated', channelId: 'channel-1' } },
    nodes: [{ id: 'start', kind: 'start', title: '开始' }, { id: 'map', kind: 'transform', title: '映射', config: { assignments: { id: '$input.id' } } }, { id: 'end', kind: 'end', title: '结束' }],
    edges: [{ id: 'start-map', from: 'start', to: 'map' }, { id: 'map-end', from: 'map', to: 'end' }],
    layout: { nodes: { start: { x: 0, y: 0 }, map: { x: 100, y: 0 }, end: { x: 200, y: 0 } } }, createdAt: now, updatedAt: now,
  }
}

describe('Workflow Event 触发器', () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR; rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test('Given published event workflow When matching event arrives Then it creates a completed auditable Run with payload', async () => {
    const workspace = createAgentWorkspace('事件工作区')
    const definition = eventDefinition(workspace.id)
    saveWorkflowDefinition(definition)
    publishWorkflowDefinition(definition.id, { version: '1.0.0' })
    const runs = await triggerWorkflowEvent('project.updated', { id: 'project-1' })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.trigger).toBe('event')
    expect(runs[0]?.nodeRuns?.map?.output).toEqual({ id: 'project-1' })
    expect(runs[0]?.status).toBe('completed')
  })

  test('Given unmatched event When triggered Then no workflow starts', async () => {
    const workspace = createAgentWorkspace('事件工作区')
    const definition = eventDefinition(workspace.id)
    saveWorkflowDefinition(definition)
    publishWorkflowDefinition(definition.id, { version: '1.0.0' })
    expect(await triggerWorkflowEvent('other.event', {})).toEqual([])
  })
})
