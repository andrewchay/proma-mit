import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createAgentExecution, createProject, deleteProject, getAgentExecution, getProjectDb, initProjectDb, updateAgentExecution } from './project-sqlite-store'
import { assertPilotExecutionLinked, cancelLinkedQueuedPilotExecutions, listPilotCommandLinks, registerPilotCommandLink } from './project-pilot-command-links'

const dir = mkdtempSync(join(tmpdir(), 'pilot-command-link-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

test('同一命令与执行重复登记幂等；重启后关联仍存在', async () => {
  const project = createProject({ title: '关联项目', description: '' })
  createAgentExecution({ id: 'linked-run', projectId: project.id, entityType: 'task', entityId: 'task-a',
    agentId: 'employee-a', sessionId: '', prompt: 'fixture', pilotCommandId: 'command-a' })
  const input = { commandId: 'command-a', projectId: project.id, policyRevision: 1, executionId: 'linked-run' }
  const first = registerPilotCommandLink(input)
  expect(registerPilotCommandLink(input)).toEqual(first)
  closeProjectDb()
  await initProjectDb()
  expect(listPilotCommandLinks(project.id)).toEqual([first])
  expect(deleteProject(project.id)).toBe(true)
  expect(listPilotCommandLinks(project.id)).toEqual([])
})

test('不同项目、未标记执行、同命令改绑与错误版本均拒绝', () => {
  const project = createProject({ title: '防混淆', description: '' })
  const other = createProject({ title: '其他', description: '' })
  createAgentExecution({ id: 'marked-run', projectId: project.id, entityType: 'task', entityId: 'task-b',
    agentId: 'employee-b', sessionId: '', prompt: 'fixture', pilotCommandId: 'command-b' })
  createAgentExecution({ id: 'plain-run', projectId: project.id, entityType: 'task', entityId: 'task-b',
    agentId: 'employee-b', sessionId: '', prompt: 'fixture' })
  expect(() => registerPilotCommandLink({ commandId: 'command-b', projectId: other.id, policyRevision: 1, executionId: 'marked-run' }))
    .toThrow('归属不一致')
  expect(() => registerPilotCommandLink({ commandId: 'command-b', projectId: project.id, policyRevision: 1, executionId: 'plain-run' }))
    .toThrow('归属不一致')
  registerPilotCommandLink({ commandId: 'command-b', projectId: project.id, policyRevision: 1, executionId: 'marked-run' })
  expect(() => registerPilotCommandLink({ commandId: 'command-b', projectId: project.id, policyRevision: 2, executionId: 'marked-run' }))
    .toThrow('已被其他执行占用')
})


test('确认后仅取消归属可核验的未启动 Pilot 队列，并在同一事务记录活动', () => {
  const project = createProject({ title: '确认取消', description: '' })
  const target = { executionId: `queued-${project.id}`, commandId: `command-${project.id}` }
  createAgentExecution({ id: target.executionId, projectId: project.id, entityType: 'task', entityId: 'task-c',
    agentId: 'employee-c', sessionId: '', prompt: 'fixture', pilotCommandId: target.commandId })
  registerPilotCommandLink({ ...target, projectId: project.id, policyRevision: 1 })
  expect(cancelLinkedQueuedPilotExecutions(project.id, [target])).toEqual([target.executionId])
  expect(getAgentExecution(target.executionId)?.status).toBe('cancelled')
  const audit = getProjectDb().prepare("SELECT action FROM project_activities WHERE project_id = ? AND entity_id = ?")
    .all(project.id, target.executionId) as Array<{ action: string }>
  expect(audit.map((item) => item.action)).toContain('pilot_queued_cancelled')
  expect(() => cancelLinkedQueuedPilotExecutions(project.id, [target])).toThrow('已变化')
})

test('任一排队项已启动或归属未登记时，整批取消回滚且不触碰普通执行', () => {
  const project = createProject({ title: '竞态保护', description: '' })
  const targets = [
    { executionId: `first-${project.id}`, commandId: `first-command-${project.id}` },
    { executionId: `second-${project.id}`, commandId: `second-command-${project.id}` },
  ]
  for (const target of targets) {
    createAgentExecution({ id: target.executionId, projectId: project.id, entityType: 'task', entityId: 'task-d',
      agentId: 'employee-d', sessionId: '', prompt: 'fixture', pilotCommandId: target.commandId })
    registerPilotCommandLink({ ...target, projectId: project.id, policyRevision: 1 })
  }
  createAgentExecution({ id: `manual-${project.id}`, projectId: project.id, entityType: 'task', entityId: 'task-d',
    agentId: 'employee-d', sessionId: '', prompt: 'fixture' })
  updateAgentExecution(targets[1]!.executionId, { status: 'running', sessionId: 'started' })
  expect(() => cancelLinkedQueuedPilotExecutions(project.id, targets)).toThrow('已变化')
  expect(getAgentExecution(targets[0]!.executionId)?.status).toBe('queued')
  expect(getAgentExecution(`manual-${project.id}`)?.status).toBe('queued')
  expect(() => cancelLinkedQueuedPilotExecutions(project.id, [{ executionId: `manual-${project.id}`, commandId: 'fake' }]))
    .toThrow('归属无法核验')
})


test('启动前必须同时核对执行标记和持久命令关联', () => {
  const project = createProject({ title: '启动来源', description: '' })
  const base = { projectId: project.id, entityType: 'task' as const, entityId: 'task-e',
    agentId: 'employee-e', sessionId: '', prompt: 'fixture' }
  createAgentExecution({ ...base, id: `linked-${project.id}`, pilotCommandId: `command-${project.id}` })
  createAgentExecution({ ...base, id: `unlinked-${project.id}`, pilotCommandId: `other-command-${project.id}` })
  createAgentExecution({ ...base, id: `plain-${project.id}` })
  const link = registerPilotCommandLink({ commandId: `command-${project.id}`, projectId: project.id,
    policyRevision: 1, executionId: `linked-${project.id}` })
  expect(assertPilotExecutionLinked(`linked-${project.id}`, 1)).toEqual(link)
  expect(() => assertPilotExecutionLinked(`linked-${project.id}`, 2)).toThrow('策略版本已失效')
  expect(() => assertPilotExecutionLinked(`unlinked-${project.id}`)).toThrow('关联无法核验')
  expect(() => assertPilotExecutionLinked(`plain-${project.id}`)).toThrow('缺少 Pilot 命令归属')
})
