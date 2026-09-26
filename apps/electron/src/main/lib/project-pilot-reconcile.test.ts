import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeProjectDb, createAgentExecution, createProject, createTask,
  createTaskDependency, initProjectDb, updateAgentExecution, updateTask,
} from './project-sqlite-store'
import { observeProjectPilot } from './project-pilot-reconcile'
import { getProjectChain, updateProjectChain } from './project-chain-service'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-pilot-observe-'))
const previousDirectory = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = directory
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  if (previousDirectory === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

test('项目只读对账：依赖解除后 waiting 转 ready，重复读取不创建执行', async () => {
  const project = createProject({ title: '只读项目', description: '' })
  const upstream = createTask(project.id, { title: '上游', description: '' })
  const downstream = createTask(project.id, { title: '下游', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createTaskDependency(downstream.id, upstream.id)
  const first = await observeProjectPilot(project.id)
  expect(first.mode).toBe('read_only')
  expect(first.tasks.find((task) => task.taskId === downstream.id)?.state).toBe('waiting_dependency')
  expect(first.tasks.find((task) => task.taskId === downstream.id)?.blockerTaskIds).toEqual([upstream.id])
  updateTask(upstream.id, { status: 'completed' })
  const second = await observeProjectPilot(project.id)
  expect(second.tasks.find((task) => task.taskId === downstream.id)?.state).toBe('ready')
  expect(second.fingerprint).not.toBe(first.fingerprint)
  expect((await observeProjectPilot(project.id)).fingerprint).toBe(second.fingerprint)
  expect(second.tasks.every((task) => task.executionId === undefined)).toBe(true)
})

test('执行完成不等于交付提交，不能误报待审阅；跨项目任务不进入快照', async () => {
  const project = createProject({ title: '执行项目', description: '' })
  const other = createProject({ title: '另一个项目', description: '' })
  const task = createTask(project.id, { title: '交付', description: '' })
  createTask(other.id, { title: '不能串入', description: '' })
  const run = createAgentExecution({
    id: 'pilot-observation-execution', projectId: project.id, entityType: 'task', entityId: task.id,
    agentId: 'test-agent', sessionId: '', prompt: 'fixture', status: 'queued', startedAt: Date.now(),
  })
  updateAgentExecution(run.id, { status: 'completed', completedAt: Date.now() })
  updateTask(task.id, { status: 'paused' })
  const observed = await observeProjectPilot(project.id)
  expect(observed.tasks).toHaveLength(1)
  expect(observed.tasks[0]?.state).toBe('needs_attention')
  expect(observed.tasks[0]?.reason).toContain('待核对交付版本')
  expect(observed.tasks[0]?.executionId).toBe(run.id)
  expect((await observeProjectPilot(other.id)).tasks[0]?.title).toBe('不能串入')
  expect((await observeProjectPilot(project.id)).fingerprint).toBe(observed.fingerprint)
})

test('有正式交接时，上游完成仍等待下游接收', async () => {
  const project = createProject({ title: '交接项目', description: '' })
  const assignee = { userId: 'local-user', displayName: '本地用户' }
  const upstream = createTask(project.id, { title: '构建', description: '', assignee })
  const downstream = createTask(project.id, { title: '测试', description: '', assignee })
  const dependency = createTaskDependency(downstream.id, upstream.id)
  updateTask(upstream.id, { status: 'completed' })
  let chain = updateProjectChain(project.id, getProjectChain(project.id).revision, {
    kind: 'define_dependency_handoff', dependencyId: dependency.id,
    upstreamTaskId: upstream.id, downstreamTaskId: downstream.id,
    need: '构建产物', providerId: 'local-user', consumerId: 'local-user',
    dueAt: Date.now() + 86_400_000, criteria: ['可测试'],
  })
  expect((await observeProjectPilot(project.id)).tasks.find((task) => task.taskId === downstream.id)?.state).toBe('waiting_dependency')
  chain = updateProjectChain(project.id, chain.revision, { kind: 'offer_dependency_handoff', dependencyId: dependency.id, comment: '构建完成' })
  expect((await observeProjectPilot(project.id)).tasks.find((task) => task.taskId === downstream.id)?.state).toBe('waiting_dependency')
  updateProjectChain(project.id, chain.revision, {
    kind: 'accept_dependency_handoff', dependencyId: dependency.id, comment: '收到', completedCriteria: ['可测试'],
  })
  expect((await observeProjectPilot(project.id)).tasks.find((task) => task.taskId === downstream.id)?.state).toBe('ready')
})

test('候选决策只作为待处理投影，链路版本变化后刷新', async () => {
  const project = createProject({ title: '决策项目', description: '' })
  let chain = updateProjectChain(project.id, getProjectChain(project.id).revision, {
    kind: 'decision', title: '发布方向', rationale: '需要确认', evidence: '会议记录',
    deadlineAt: Date.now() + 86_400_000,
    sourceRefs: [{ sourceType: 'meeting', sourceId: 'fixture-note', locator: 'section:1' }],
    daci: { driverId: 'local-user', approverId: 'local-user', contributorIds: [], informedIds: [] },
  })
  const before = await observeProjectPilot(project.id)
  expect(before.attention).toEqual([expect.objectContaining({ sourceType: 'decision', sourceId: chain.decisions[0]?.id })])
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'approve_decision', decisionId: chain.decisions[0]!.id, comment: '确认',
  })
  const after = await observeProjectPilot(project.id)
  expect(after.attention).toEqual([])
  expect(after.fingerprint).not.toBe(before.fingerprint)
})

test('提交的交付物以链路状态投影待审阅，执行记录不冒充交付', async () => {
  const project = createProject({ title: '交付项目', description: '' })
  const task = createTask(project.id, { title: '文件', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  let chain = updateProjectChain(project.id, getProjectChain(project.id).revision, {
    kind: 'decision', title: '文件方向', rationale: '明确范围', evidence: 'fixture',
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'draft', taskId: task.id, title: '文件交付', content: '结果', criteria: '可读', recipient: 'local-user',
    responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
    decisionIds: [chain.decisions[0]!.id],
  })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId: chain.drafts[0]!.id })
  updateTask(task.id, { status: 'paused' })
  const observed = await observeProjectPilot(project.id)
  expect(observed.tasks[0]?.state).toBe('awaiting_review')
  expect(observed.attention).toEqual([expect.objectContaining({ sourceType: 'delivery', sourceId: chain.drafts[0]?.id, taskId: task.id })])
})

test('未指派、进行中无执行、草稿不能误报为可安排', async () => {
  const project = createProject({ title: '状态区分', description: '' })
  const unassigned = createTask(project.id, { title: '未指派', description: '' })
  const started = createTask(project.id, { title: '进行中', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  updateTask(started.id, { status: 'in_progress' })
  const observed = await observeProjectPilot(project.id)
  expect(observed.tasks.find((task) => task.taskId === unassigned.id)?.state).toBe('needs_attention')
  expect(observed.tasks.find((task) => task.taskId === started.id)?.state).toBe('needs_attention')
})

test('缺失项目拒绝，只读对账不自动创建项目', async () => {
  await expect(observeProjectPilot('missing-project')).rejects.toThrow('项目不存在')
  await expect(observeProjectPilot('')).rejects.toThrow('缺少项目 ID')
  await expect(observeProjectPilot(42 as unknown as string)).rejects.toThrow('缺少项目 ID')
})
