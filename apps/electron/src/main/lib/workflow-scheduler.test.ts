import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from '@proma/shared'
import { createAgentWorkspace } from './agent-workspace-manager'
import { listWorkflowRuns, publishWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'
import { calculateWorkflowNextRunAt, triggerWorkflowSchedulerTick } from './workflow-scheduler'

const TEST_DIR = '/tmp/paa-workflow-scheduler-test'

function scheduledDefinition(workspaceId: string): WorkflowDefinition {
  const now = Date.now()
  return {
    format: WORKFLOW_FORMAT, formatVersion: '1.0', id: 'scheduled-flow', workspaceId, name: '定时流程', status: 'draft', version: '0.1.0',
    trigger: { kind: 'schedule', config: { mode: 'interval', interval: 1, intervalUnit: 'minutes', channelId: 'channel-1', input: { source: 'scheduler' } } },
    nodes: [{ id: 'start', kind: 'start', title: '开始' }, { id: 'map', kind: 'transform', title: '映射', config: { assignments: { source: '$input.source' } } }, { id: 'end', kind: 'end', title: '结束' }],
    edges: [{ id: 'start-map', from: 'start', to: 'map' }, { id: 'map-end', from: 'map', to: 'end' }],
    layout: { nodes: { start: { x: 0, y: 0 }, map: { x: 100, y: 0 }, end: { x: 200, y: 0 } } }, createdAt: now, updatedAt: now,
  }
}

describe('Workflow Scheduler', () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR; rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test('Given published interval workflow When two ticks cross nextRunAt Then it creates one auditable scheduled Run', async () => {
    const workspace = createAgentWorkspace('定时流程工作区')
    const definition = scheduledDefinition(workspace.id)
    saveWorkflowDefinition(definition)
    publishWorkflowDefinition(definition.id, { version: '1.0.0' })
    const start = new Date(2026, 0, 1, 9, 0).getTime()

    await triggerWorkflowSchedulerTick(start)
    expect(listWorkflowRuns(definition.id)).toHaveLength(0)
    await triggerWorkflowSchedulerTick(start + 60_000)

    const runs = listWorkflowRuns(definition.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.trigger).toBe('schedule')
    expect(runs[0]?.status).toBe('completed')
  })

  test('Given daily schedule When calculating from the same minute Then it schedules tomorrow', () => {
    const now = new Date(2026, 0, 1, 9, 0).getTime()
    expect(calculateWorkflowNextRunAt({ mode: 'daily', time: '09:00', channelId: 'channel-1' }, now)).toBe(new Date(2026, 0, 2, 9, 0).getTime())
  })
})
