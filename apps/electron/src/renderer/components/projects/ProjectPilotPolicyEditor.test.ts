import { expect, test } from 'bun:test'
import type { AgentEmployeeResult } from '@gravitas/shared'
import { isPilotEmployeeCandidate } from './ProjectPilotPolicyEditor'

const employee = (patch: Partial<AgentEmployeeResult> = {}): AgentEmployeeResult => ({
  id: 'employee-a', name: '研发员工', role: '研发', description: '', runtime: 'proma',
  channelId: 'channel-a', modelId: 'model-a', workspaceIds: ['workspace-a'],
  executionProfile: 'development', permissionMode: 'safe', skills: [], enabled: true,
  totalTasks: 0, completedTasks: 0, failureCount: 0, createdAt: 1, updatedAt: 1,
  ...patch,
})

test('Given 策略草案员工选择器 When 筛选候选 Then 只展示安全研发运行路径', () => {
  expect(isPilotEmployeeCandidate(employee())).toBe(true)
  expect(isPilotEmployeeCandidate(employee({ enabled: false }))).toBe(false)
  expect(isPilotEmployeeCandidate(employee({ executionProfile: 'general' }))).toBe(false)
  expect(isPilotEmployeeCandidate(employee({ permissionMode: 'auto' }))).toBe(false)
  expect(isPilotEmployeeCandidate(employee({ runtime: 'claude-sdk' }))).toBe(false)
  expect(isPilotEmployeeCandidate(employee({ workflowId: 'workflow-a' }))).toBe(false)
  expect(isPilotEmployeeCandidate(employee({ modelId: undefined }))).toBe(false)
})
