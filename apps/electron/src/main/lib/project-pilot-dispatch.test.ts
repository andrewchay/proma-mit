import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectPilotDispatchTesting } from './project-pilot-dispatch'
import { getCurrentPilotIntents } from './project-pilot-intent-store'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import {
  closeProjectDb,
  createAgentEmployee,
  createProject,
  createTask,
  getAgentExecution,
  getProjectDb,
  initProjectDb,
  listAgentExecutionsByProject,
  updateTask,
} from './project-sqlite-store'

const directory = mkdtempSync(join(tmpdir(), 'pilot-dispatch-'))
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

function fixture() {
  const executor = createAgentEmployee({
    name: 'Pilot 执行者', role: '工程师', description: '', channelId: 'channel-a', modelId: 'model-a',
    workspaceId: 'workspace-a', workspaceIds: ['workspace-a'], runtime: 'proma', executionProfile: 'development',
  })
  const reviewer = createAgentEmployee({
    name: 'Pilot 评审者', role: '技术评审', description: '', channelId: 'channel-a', modelId: 'model-a',
    workspaceId: 'workspace-a', workspaceIds: ['workspace-a'], runtime: 'proma', executionProfile: 'development',
  })
  const project = createProject({ title: '受控派发', description: '' })
  const task = createTask(project.id, {
    title: '实现受控变更', description: '只进入账本，不调用模型', workspaceId: 'workspace-a',
    assignee: { userId: `agent-${executor.id}`, displayName: executor.name },
  })
  const grantId = `grant-${project.id}`
  const now = Date.now()
  insertPilotGrantFixture({
    grantId, projectId: project.id, workspaceId: 'workspace-a', channelId: 'channel-a', modelId: 'model-a',
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
    maxCostMicros: 1_000, maxRuns: 2, maxRework: 1, expiresAt: now + 100_000, createdAt: now,
  })
  return { project, task, executor, reviewer, grantId, now }
}

const ready = (projectId: string) => ({
  projectId, policyRevision: 1, bindingsValid: true, blockers: [],
})

test('Given 当前 ready 候选和活动授权 When 受控派发 Then 派生唯一命令并原子排队', async () => {
  const { project, task, executor, grantId, now } = fixture()
  const intent = (await getCurrentPilotIntents(project.id)).find((item) => item.sourceId === task.id)!
  let startExecutionId = ''
  const result = await projectPilotDispatchTesting.dispatch(project.id, intent.id, {
    inspectReadiness: ready,
    startExecution: async (executionId) => { startExecutionId = executionId; return false },
  }, now)
  expect(result).toMatchObject({ intentId: intent.id, started: false })
  expect(result.commandId).toStartWith('pilot-command-')
  expect(result.executionId).toStartWith('pilot-execution-')
  expect(startExecutionId).toBe(result.executionId)
  expect(getAgentExecution(result.executionId)).toMatchObject({
    projectId: project.id, entityId: task.id, agentId: executor.id, status: 'queued',
    pilotCommandId: result.commandId,
  })
  expect(getProjectDb().prepare(`SELECT grant_id, source_task_id, employee_id, role, state, execution_id
    FROM pilot_commands WHERE id = ?`).get(result.commandId)).toEqual({
    grant_id: grantId, source_task_id: task.id, employee_id: executor.id,
    role: 'executor', state: 'queued', execution_id: result.executionId,
  })
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(1)
  await expect(projectPilotDispatchTesting.dispatch(project.id, intent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, now)).rejects.toThrow('候选已失效或不可派发')
  expect(listAgentExecutionsByProject(project.id)).toHaveLength(1)
})

test('Given 旧候选、失效 readiness 或角色工作区漂移 When 派发 Then 不创建命令或执行', async () => {
  const stale = fixture()
  const staleIntent = (await getCurrentPilotIntents(stale.project.id))[0]!
  updateTask(stale.task.id, { title: '来源已变化' })
  await expect(projectPilotDispatchTesting.dispatch(stale.project.id, staleIntent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, stale.now)).rejects.toThrow('候选已失效或不可派发')
  expect(listAgentExecutionsByProject(stale.project.id)).toEqual([])

  const blocked = fixture()
  const blockedIntent = (await getCurrentPilotIntents(blocked.project.id))[0]!
  await expect(projectPilotDispatchTesting.dispatch(blocked.project.id, blockedIntent.id, {
    inspectReadiness: (projectId) => ({ projectId, policyRevision: 1, bindingsValid: false, blockers: ['fixture'] }),
    startExecution: async () => false,
  }, blocked.now)).rejects.toThrow('活动授权或当前绑定未通过')
  expect(listAgentExecutionsByProject(blocked.project.id)).toEqual([])

  const drifted = fixture()
  const driftedIntent = (await getCurrentPilotIntents(drifted.project.id))[0]!
  getProjectDb().prepare('UPDATE tasks SET workspace_id = ? WHERE id = ?').run('other-workspace', drifted.task.id)
  await expect(projectPilotDispatchTesting.dispatch(drifted.project.id, driftedIntent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, drifted.now)).rejects.toThrow('执行角色或工作区不匹配')
  expect(listAgentExecutionsByProject(drifted.project.id)).toEqual([])
})

test('Given 后台停止信号 When 候选准备派发 Then 不预留命令或创建执行', async () => {
  const { project } = fixture()
  const intent = (await getCurrentPilotIntents(project.id))[0]!
  const controller = new AbortController()
  controller.abort()
  await expect(projectPilotDispatchTesting.dispatch(project.id, intent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, Date.now(), controller.signal)).rejects.toThrow('对账已停止')
  expect(listAgentExecutionsByProject(project.id)).toEqual([])
})

/** 评审派发夹具：同一授权下执行任务与评审任务都处于 ready。 */
function reviewerFixture() {
  const base = fixture()
  const reviewerTask = createTask(base.project.id, {
    title: '评审执行交付', description: '在执行命令结算后进入评审 run', workspaceId: 'workspace-a',
    assignee: { userId: `agent-${base.reviewer.id}`, displayName: base.reviewer.name },
  })
  return { ...base, reviewerTask }
}

test('Given 执行命令尚未结算 When 派发评审候选 Then 拒绝且不预留命令', async () => {
  const { project, reviewerTask, now } = reviewerFixture()
  const intent = (await getCurrentPilotIntents(project.id)).find((item) => item.sourceId === reviewerTask.id)!
  await expect(projectPilotDispatchTesting.dispatch(project.id, intent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, now)).rejects.toThrow('评审命令须在执行命令结算后派发')
  expect(getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE project_id = ?').get(project.id))
    .toEqual({ n: 0 })
})

test('Given 执行命令已结算 When 派发评审候选与第三个候选 Then 评审占用第 2 次 run 且超额拒绝', async () => {
  const fx = reviewerFixture()
  const intents = await getCurrentPilotIntents(fx.project.id)
  const executorIntent = intents.find((item) => item.sourceId === fx.task.id)!
  await projectPilotDispatchTesting.dispatch(fx.project.id, executorIntent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, fx.now)
  getProjectDb().prepare(`UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 100
    WHERE project_id = ? AND role = 'executor'`).run(fx.project.id)
  const reviewerIntent = (await getCurrentPilotIntents(fx.project.id)).find((item) => item.sourceId === fx.reviewerTask.id)!
  const result = await projectPilotDispatchTesting.dispatch(fx.project.id, reviewerIntent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, fx.now)
  expect(result.commandId).toStartWith('pilot-command-')
  expect(getProjectDb().prepare('SELECT role, employee_id, state, rework_ordinal FROM pilot_commands WHERE id = ?')
    .get(result.commandId)).toEqual({ role: 'reviewer', employee_id: fx.reviewer.id, state: 'queued', rework_ordinal: 0 })
  expect(getAgentExecution(result.executionId)).toMatchObject({ agentId: fx.reviewer.id, status: 'queued' })
  expect(getProjectDb().prepare(`SELECT count(*) AS n FROM pilot_commands WHERE grant_id = ? AND state != 'released'`)
    .get(fx.grantId)).toEqual({ n: 2 })

  const extraTask = createTask(fx.project.id, {
    title: '超出授权的追加任务', description: '授权仅 2 次 run', workspaceId: 'workspace-a',
    assignee: { userId: `agent-${fx.executor.id}`, displayName: fx.executor.name },
  })
  const extraIntent = (await getCurrentPilotIntents(fx.project.id)).find((item) => item.sourceId === extraTask.id)!
  await expect(projectPilotDispatchTesting.dispatch(fx.project.id, extraIntent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, fx.now)).rejects.toThrow('Pilot 执行次数额度已耗尽')
  expect(getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE project_id = ?').get(fx.project.id))
    .toEqual({ n: 2 })
})

test('Given 候选负责人既非执行也非评审员工 When 派发 Then 拒绝且不创建命令', async () => {
  const drifted = reviewerFixture()
  const intent = (await getCurrentPilotIntents(drifted.project.id)).find((item) => item.sourceId === drifted.reviewerTask.id)!
  getProjectDb().prepare('UPDATE tasks SET assignee_user_id = ? WHERE id = ?').run('agent-stranger', drifted.reviewerTask.id)
  await expect(projectPilotDispatchTesting.dispatch(drifted.project.id, intent.id, {
    inspectReadiness: ready, startExecution: async () => false,
  }, drifted.now)).rejects.toThrow('执行角色或工作区不匹配')
  expect(listAgentExecutionsByProject(drifted.project.id)).toEqual([])
})
