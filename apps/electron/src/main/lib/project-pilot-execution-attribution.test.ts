import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createAgentExecution, createProject, getAgentExecution, getProjectDb, initProjectDb, listAgentExecutionsByProject, updateAgentExecution } from './project-sqlite-store'

const dir = mkdtempSync(join(tmpdir(), 'pilot-execution-origin-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

test('Given 旧普通执行和 Pilot 关联执行 When 保存与重开 Then 仅显式来源被标记且身份不随状态修改', async () => {
  const project = createProject({ title: '暂停影响面', description: '' })
  const other = createProject({ title: '其他项目', description: '' })
  const base = { projectId: project.id, entityType: 'task' as const, entityId: 'task-a', agentId: 'employee-a', sessionId: '', prompt: 'fixture' }
  createAgentExecution({ ...base, id: 'manual-run' })
  createAgentExecution({ ...base, id: 'pilot-run', pilotCommandId: 'pilot-command-a' })
  createAgentExecution({ ...base, id: 'other-project-run', projectId: other.id })
  expect(getAgentExecution('manual-run')?.pilotCommandId).toBeUndefined()
  expect(getAgentExecution('pilot-run')?.pilotCommandId).toBe('pilot-command-a')
  updateAgentExecution('pilot-run', { status: 'running' })
  closeProjectDb()
  await initProjectDb()
  const projectRuns = listAgentExecutionsByProject(project.id)
  expect(projectRuns).toHaveLength(2)
  expect(projectRuns.find((run) => run.id === 'pilot-run')?.pilotCommandId).toBe('pilot-command-a')
  expect(projectRuns.find((run) => run.id === 'manual-run')?.pilotCommandId).toBeUndefined()
  expect(getAgentExecution('other-project-run')?.projectId).toBe(other.id)
})

test('Given 已初始化数据库 Then Pilot 归属列存在', () => {
  const columns = getProjectDb().prepare('PRAGMA table_info(agent_executions)').all() as Array<{ name: string }>
  expect(columns.some((column) => column.name === 'pilot_command_id')).toBe(true)
})

test('Given 旧库没有 Pilot 归属列 When 重开数据库 Then 幂等迁移补列并保留普通执行', async () => {
  const database = getProjectDb()
  database.prepare('DELETE FROM agent_executions WHERE pilot_command_id IS NOT NULL').run()
  database.exec('ALTER TABLE agent_executions DROP COLUMN pilot_command_id')
  closeProjectDb()
  await initProjectDb()
  const columns = getProjectDb().prepare('PRAGMA table_info(agent_executions)').all() as Array<{ name: string }>
  expect(columns.some((column) => column.name === 'pilot_command_id')).toBe(true)
  expect(getAgentExecution('manual-run')?.pilotCommandId).toBeUndefined()
  expect(getAgentExecution('manual-run')?.prompt).toBe('fixture')
})
