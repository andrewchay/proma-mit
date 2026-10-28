import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-workflow-stop-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const workflowService = await import('./workflow-service')
let workflowStatus = 'running'
let cancellations = 0
mock.module('./workflow-service', () => ({ ...workflowService, getWorkflowRun: () => ({ status: workflowStatus }), cancelWorkflowRun: () => { cancellations++; workflowStatus = 'cancelled'; return { status: 'cancelled' } } }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

test('Given Workflow 只记录取消状态 When 停止正在运行的执行 Then 不声称进程已终止', () => {
  const employee = store.createAgentEmployee({ name: '工作流员工', role: '测试', description: '', channelId: 'channel', workflowId: 'workflow-test' })
  const project = store.createProject({ title: '测试项目', description: '' })
  const task = store.createTask(project.id, { title: '任务', description: '' })
  const execution = store.createAgentExecution({ id: 'execution', projectId: project.id, entityType: 'task', entityId: task.id, agentId: employee.id, sessionId: 'workflow:run-test', prompt: '测试' })
  store.updateAgentExecution(execution.id, { status: 'running' })
  expect(employees.cancelAgentExecution(execution.id)).toMatchObject({ status: 'running', stopped: false, stopRequested: true, processTermination: 'NOT_VERIFIED' })
  expect(employees.cancelAgentExecution(execution.id)).toMatchObject({ status: 'running', stopped: false, stopRequested: true, processTermination: 'NOT_VERIFIED' })
  expect(cancellations).toBe(1)
  expect(store.getAgentExecution(execution.id)?.status).toBe('running')
})
