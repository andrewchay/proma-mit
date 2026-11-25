import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-default-team-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())

const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createOwnerDedicatedWorkspace } = await import('./project-owner-dev-workspace')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { ensureOwnerDefaultTeam } = await import('./project-owner-default-team')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function setup(title: string, createWorkspace: () => { id: string }) {
  const project = store.createProject({ title, description: '' })
  const workspace = createWorkspace()
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: `fake ${title}`, provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const owner = employees.createAgentEmployee({ name: `Owner-${title}`, role: '项目管理者', description: '', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id], executionProfile: 'controlled', permissionMode: 'safe' })
  const binding = saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  return { project, workspace, owner, binding }
}

test('Given Owner专用工作区带Git基线 When 准备默认团队 Then 员工具备研发执行方式', () => {
  const f = setup('研发团队', () => createOwnerDedicatedWorkspace(`Owner-dev-team-${randomUUID().slice(0, 6)}`))
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  const team = employees.listAgentEmployees().filter(employee => employee.id !== f.owner.id && employee.workspaceIds?.includes(f.workspace.id))
  expect(team.map(employee => employee.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
  expect(team.every(employee => employee.executionProfile === 'development')).toBe(true)
})

test('Given Owner工作区没有rootPath When 准备默认团队 Then 员工保持受控文本执行方式', () => {
  const f = setup('受控团队', () => createAgentWorkspace(`受控团队-${randomUUID()}`))
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  const team = employees.listAgentEmployees().filter(employee => employee.id !== f.owner.id && employee.workspaceIds?.includes(f.workspace.id))
  expect(team.every(employee => employee.executionProfile === 'controlled')).toBe(true)
})

test('Given rootPath存在但不是带HEAD的Git仓库 When 准备默认团队 Then 不提供必然失败的研发执行方式', () => {
  const f = setup('空仓团队', () => createAgentWorkspace(`空仓团队-${randomUUID()}`, directory))
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  const team = employees.listAgentEmployees().filter(employee => employee.id !== f.owner.id && employee.workspaceIds?.includes(f.workspace.id))
  expect(team.every(employee => employee.executionProfile === 'controlled')).toBe(true)
})

test('Given 带Git基线的应用专用仓库误建了文本团队 When 再次安排文件交付 Then 补齐独立研发团队且幂等', () => {
  const f = setup('恢复文件交付', () => createOwnerDedicatedWorkspace(`Owner-dev-team-${randomUUID().slice(0, 6)}`))
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  const team = () => employees.listAgentEmployees().filter(employee => employee.id !== f.owner.id && employee.workspaceIds?.includes(f.workspace.id))
  const oldTeam = team()
  for (const employee of oldTeam) store.getProjectDb().prepare("UPDATE agent_employees SET execution_profile='controlled' WHERE id=?").run(employee.id)
  expect(ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'], true)).toBe(true)
  expect(ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'], true)).toBe(false)
  expect(team().filter(employee => employee.executionProfile === 'development').map(employee => employee.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
  expect(team().filter(employee => employee.executionProfile === 'controlled').map(employee => employee.id).sort()).toEqual(oldTeam.map(employee => employee.id).sort())
})

test('Given 工作区只支持文本 When 计划明确需要文件交付 Then 不提前固化不适合的默认团队', () => {
  const f = setup('等待Git基线', () => createAgentWorkspace(`受控团队-${randomUUID()}`))
  expect(ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'], true)).toBe(false)
  expect(employees.listAgentEmployees().filter(employee => employee.workspaceIds?.includes(f.workspace.id)).map(employee => employee.id)).toEqual([f.owner.id])
})

test('Given 用户修改过默认员工指令 When 核对文件岗位 Then 保留团队且不新增替代员工', () => {
  const f = setup('已有用户配置', () => createOwnerDedicatedWorkspace(`Owner-dev-team-${randomUUID().slice(0, 6)}`))
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  const team = () => employees.listAgentEmployees().filter(employee => employee.id !== f.owner.id && employee.workspaceIds?.includes(f.workspace.id))
  const employee = team().find(item => item.roleTemplateId === 'requirements-analyst')!
  store.getProjectDb().prepare("UPDATE agent_employees SET execution_profile='controlled', system_prompt=? WHERE id=?").run('用户配置', employee.id)
  expect(ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'], true)).toBe(false)
  expect(team()).toHaveLength(2)
})
