import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, createTask, createTaskDependency, deleteProject, getProjectDb, initProjectDb, listAgentExecutionsByProject, updateTask } from './project-sqlite-store'
import { getCurrentPilotIntents, listPilotIntentHistory, reconcilePilotIntents, reconcilePilotOverview } from './project-pilot-intent-store'

const dir = mkdtempSync(join(tmpdir(), 'pilot-intent-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})
const assignee = { userId: 'local-user', displayName: '本地用户' }

test('Given 依赖阻塞 When 重读与解除 Then 意图去重且旧版失效，不产生执行记录', async () => {
  const project = createProject({ title: '意图项目', description: '' })
  const upstream = createTask(project.id, { title: '上游', description: '', assignee })
  const downstream = createTask(project.id, { title: '下游', description: '', assignee })
  createTaskDependency(downstream.id, upstream.id)
  const first = await getCurrentPilotIntents(project.id)
  expect(first.find((item) => item.sourceId === downstream.id)?.kind).toBe('dependency_wait')
  expect(await getCurrentPilotIntents(project.id)).toEqual(first)
  updateTask(upstream.id, { status: 'completed' })
  const open = await getCurrentPilotIntents(project.id)
  expect(open.find((item) => item.sourceId === downstream.id)?.kind).toBe('ready_candidate')
  expect(listPilotIntentHistory(project.id).find((item) => item.id === first.find((old) => old.sourceId === downstream.id)?.id)?.status).toBe('stale')
  expect(open.every((item) => item.kind !== 'dependency_wait')).toBe(true)
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(0)
})

test('Given 同项目并发对账 When 状态变化 Then 最终读取必须重读权威事实', async () => {
  const project = createProject({ title: '串行项目', description: '' })
  const upstream = createTask(project.id, { title: '上游', description: '' })
  const downstream = createTask(project.id, { title: '下游', description: '', assignee })
  createTaskDependency(downstream.id, upstream.id)
  const pending = reconcilePilotIntents(project.id)
  updateTask(upstream.id, { status: 'completed' })
  const latest = getCurrentPilotIntents(project.id)
  await Promise.all([pending, latest])
  const open = await getCurrentPilotIntents(project.id)
  expect(open.find((item) => item.sourceId === downstream.id)?.kind).toBe('ready_candidate')
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(0)
})

test('Given 两个项目 When 记录相似任务 Then 不交叉；删除项目清理意图', async () => {
  const first = createProject({ title: '甲', description: '' })
  const second = createProject({ title: '乙', description: '' })
  createTask(first.id, { title: '一样', description: '', assignee })
  createTask(second.id, { title: '一样', description: '', assignee })
  const a = await getCurrentPilotIntents(first.id)
  const b = await getCurrentPilotIntents(second.id)
  expect(a).toHaveLength(1)
  expect(b).toHaveLength(1)
  expect(a[0]?.id).not.toBe(b[0]?.id)
  expect(deleteProject(first.id)).toBe(true)
  expect(listPilotIntentHistory(first.id)).toEqual([])
  expect(listPilotIntentHistory(second.id)).toEqual(b)
  await expect(getCurrentPilotIntents(first.id)).rejects.toThrow('项目不存在')
})

test('Given 旧 open 与进程重启 When 事实已变 Then 首次展示强制重新对账', async () => {
  const project = createProject({ title: '恢复', description: '' })
  const task = createTask(project.id, { title: '待安排', description: '', assignee })
  const before = await getCurrentPilotIntents(project.id)
  expect(before[0]?.kind).toBe('ready_candidate')
  closeProjectDb()
  await initProjectDb()
  updateTask(task.id, { status: 'completed' })
  const current = await getCurrentPilotIntents(project.id)
  expect(current).toEqual([])
  expect(listPilotIntentHistory(project.id).find((item) => item.id === before[0]?.id)?.status).toBe('stale')
  expect(Object.keys(before[0] ?? {})).not.toContain('command')
})

test('Given 已初始化数据库 Then 意图表由迁移创建，而非首次查询才建表', () => {
  const rows = getProjectDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pilot_intents'").all()
  expect(rows).toHaveLength(1)
})

test('Given 概览读取 When 候选与观察一并返回 Then 候选来源与状态对应同次事实', async () => {
  const project = createProject({ title: '概览一致性', description: '' })
  const task = createTask(project.id, { title: '待安排', description: '', assignee })
  const snapshot = await reconcilePilotOverview(project.id)
  expect(snapshot.observation.tasks.find((item) => item.taskId === task.id)?.state).toBe('ready')
  expect(snapshot.intents.find((item) => item.sourceId === task.id)?.kind).toBe('ready_candidate')
  expect(snapshot.intents.every((item) => item.projectId === snapshot.observation.projectId)).toBe(true)
})
