import { expect, test } from 'bun:test'
import type { AgentExecutionResult } from '@gravitas/shared'
import { selectTaskExecution, executionStopMessage } from './project-task-execution-state'

const execution = (id: string, status: AgentExecutionResult['status'], startedAt: number): AgentExecutionResult => ({
  id, status, startedAt, agentId: 'agent', projectId: 'project', entityType: 'task', entityId: 'task', sessionId: id, prompt: '', outputFiles: [], requestedPermissions: [],
})
test('Given 记录顺序或旧终态插入 When 展示停止入口 Then 选择仍活跃的执行', () => {
  expect(selectTaskExecution([execution('old', 'failed', 3), execution('active', 'running', 2)])?.id).toBe('active')
  expect(selectTaskExecution([execution('old', 'failed', 1), execution('new', 'completed', 4)])?.id).toBe('new')
})
test('Given 取消仅请求已接受 When 展示反馈 Then 不称已停止或隐藏执行', () => {
  expect(executionStopMessage({ id: 'run', status: 'running', stopped: false, stopRequested: true, processTermination: 'NOT_VERIFIED' })).toContain('等待')
  expect(executionStopMessage({ id: 'run', status: 'cancelled', stopped: true, processTermination: 'VERIFIED' })).toContain('已取消')
})
