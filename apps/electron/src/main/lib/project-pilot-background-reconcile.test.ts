import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileAllPilotProjects, startPilotBackgroundReconcile } from './project-pilot-background-reconcile'
import { listPilotIntentHistory, reconcilePilotIntents } from './project-pilot-intent-store'
import { closeProjectDb, createProject, createTask, createTaskDependency, initProjectDb, listAgentExecutionsByProject, updateTask } from './project-sqlite-store'
import { updateTask as updateTaskWithEvents } from './project-service'

const dir = mkdtempSync(join(tmpdir(), 'pilot-background-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

test('Given 无项目页面 When 主进程启动并继续对账 Then 依赖变化持久化且不派发', async () => {
  const project = createProject({ title: '后台对账', description: '' })
  const upstream = createTask(project.id, { title: '上游', description: '' })
  const downstream = createTask(project.id, { title: '下游', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createTaskDependency(downstream.id, upstream.id)
  const stop = startPilotBackgroundReconcile()
  try {
    for (let attempt = 0; attempt < 50 && listPilotIntentHistory(project.id).length === 0; attempt++) {
      await Bun.sleep(10)
    }
    const initial = listPilotIntentHistory(project.id).find((item) => item.sourceId === downstream.id && item.status === 'open')
    expect(initial?.kind).toBe('dependency_wait')
    updateTask(upstream.id, { status: 'completed' })
    await reconcileAllPilotProjects()
    const history = listPilotIntentHistory(project.id).filter((item) => item.sourceId === downstream.id)
    expect(history.find((item) => item.id === initial?.id)?.status).toBe('stale')
    expect(history.find((item) => item.status === 'open')?.kind).toBe('ready_candidate')
    expect(listAgentExecutionsByProject(project.id)).toHaveLength(0)
  } finally {
    stop()
  }
})

test('Given 停机期间权威任务变化 When 数据库重开后对账 Then 旧候选失效且不跨项目', async () => {
  const first = createProject({ title: '恢复甲', description: '' })
  const second = createProject({ title: '恢复乙', description: '' })
  const task = createTask(first.id, { title: '任务甲', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createTask(second.id, { title: '任务乙', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  await reconcileAllPilotProjects()
  const before = listPilotIntentHistory(first.id).find((item) => item.status === 'open')
  closeProjectDb()
  await initProjectDb()
  updateTask(task.id, { status: 'completed' })
  await reconcileAllPilotProjects()
  expect(listPilotIntentHistory(first.id).find((item) => item.id === before?.id)?.status).toBe('stale')
  expect(listPilotIntentHistory(second.id).filter((item) => item.status === 'open')).toHaveLength(1)
  expect(listAgentExecutionsByProject(first.id)).toHaveLength(0)
})

test('Given 后台服务已停止 When 对账请求排队 Then 不再写入候选', async () => {
  const project = createProject({ title: '退出保护', description: '' })
  createTask(project.id, { title: '待安排', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  const controller = new AbortController()
  controller.abort()
  await expect(reconcilePilotIntents(project.id, controller.signal)).rejects.toThrow('Pilot 对账已停止')
  expect(listPilotIntentHistory(project.id)).toEqual([])
})

test('Given 依赖任务通过项目服务完成 When 页面未打开 Then 任务事件立即唤醒后台对账', async () => {
  const project = createProject({ title: '事件唤醒', description: '' })
  const upstream = createTask(project.id, { title: '事件上游', description: '' })
  const downstream = createTask(project.id, { title: '事件下游', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createTaskDependency(downstream.id, upstream.id)
  await reconcileAllPilotProjects()
  const waiting = listPilotIntentHistory(project.id).find((item) => item.sourceId === downstream.id && item.status === 'open')
  expect(waiting?.kind).toBe('dependency_wait')

  const stop = startPilotBackgroundReconcile()
  try {
    await updateTaskWithEvents(upstream.id, { status: 'completed' }, { source: 'system' })
    for (let attempt = 0; attempt < 50; attempt++) {
      const ready = listPilotIntentHistory(project.id).some((item) => item.sourceId === downstream.id
        && item.status === 'open' && item.kind === 'ready_candidate')
      if (ready) break
      await Bun.sleep(10)
    }
    expect(listPilotIntentHistory(project.id).find((item) => item.id === waiting?.id)?.status).toBe('stale')
    expect(listPilotIntentHistory(project.id).find((item) => item.sourceId === downstream.id && item.status === 'open')?.kind).toBe('ready_candidate')
    expect(listAgentExecutionsByProject(project.id)).toEqual([])
  } finally {
    stop()
  }
})

test('Given 后台服务已停止 When 任务事件到达 Then 不再唤醒或改写候选', async () => {
  const project = createProject({ title: '事件取消订阅', description: '' })
  const upstream = createTask(project.id, { title: '上游', description: '' })
  const downstream = createTask(project.id, { title: '下游', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createTaskDependency(downstream.id, upstream.id)
  await reconcileAllPilotProjects()
  const before = listPilotIntentHistory(project.id)
  const stop = startPilotBackgroundReconcile()
  stop()
  await updateTaskWithEvents(upstream.id, { status: 'completed' }, { source: 'system' })
  await Bun.sleep(20)
  expect(listPilotIntentHistory(project.id)).toEqual(before)
})
