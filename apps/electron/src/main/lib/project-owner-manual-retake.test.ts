import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-manual-retake-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const retake = await import('./project-owner-manual-retake')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const project = store.createProject({ title: '手动重排', description: '' })
  const workspace = createAgentWorkspace(`重排-${randomUUID()}`); bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: 'Owner', role: '规划', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案', constraints: [] })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  return project
}

test('Given 未确认方案 When 手动重排 Then 明确拒绝且不排队事件', () => {
  const project = fixture()
  expect(() => retake.retakeOwnerManagementAssignment({ projectId: project.id, requestId: randomUUID() })).toThrow('已确认方案')
  const events = store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck'").get(project.id) as { n: number }
  expect(events.n).toBe(0)
})

test('Given 未知字段或非法身份 When 手动重排 Then 拒绝请求', () => {
  expect(() => retake.retakeOwnerManagementAssignment({ projectId: 'p', requestId: 'r', extra: 1 })).toThrow('未知字段')
  expect(() => retake.retakeOwnerManagementAssignment({ projectId: '', requestId: 'r' })).toThrow('身份无效')
  expect(() => retake.retakeOwnerManagementAssignment(null)).toThrow('必须是对象')
})
