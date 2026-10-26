import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSendInput } from '@gravitas/shared'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-business-start-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
// 只截获交接参数，绝不调用注册Runner、Runtime或Provider。
let handoff: { input: AgentSendInput; callbacks: HeadlessAgentRunCallbacks } | undefined
let handoffCount = 0
mock.module('./agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: async (input: AgentSendInput, callbacks: HeadlessAgentRunCallbacks) => {
    handoffCount++
    handoff = { input, callbacks }
  },
  stopRegisteredAgent: () => { throw new Error('本测试不消费真实停止器') },
}))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const controlled = await import('./controlled-project-task-service')
const development = await import('./development-task-service')
const review = await import('./development-review-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function fixture(profile: 'general' | 'development' | 'controlled' = 'general') {
  const project = store.createProject({ title: 'TEMP业务边界', description: '' })
  const employee = store.createAgentEmployee({ name: 'TEMP员工', role: '执行', description: '', runtime: 'claude', channelId: 'offline-no-channel', executionProfile: profile })
  const task = store.createTask(project.id, { title: '普通身份先建后附异常历史', description: '', assignee: { userId: `agent-${employee.id}`, displayName: employee.name } })
  return { project, employee, task }
}
function restrict(taskId: string, kind: 'marker' | 'empty' | 'link' = 'marker'): void {
  if (kind !== 'link') {
    store.getProjectDb().prepare('UPDATE tasks SET owner_step_link_id=? WHERE id=?').run(kind === 'empty' ? '' : 'broken-owner-link', taskId)
    return
  }
  const task = store.getTask(taskId)!
  store.getProjectDb().prepare(`INSERT INTO project_owner_task_step_links
    (id, materialization_id, project_id, subject_key, plan_fingerprint, step_key, task_id, payload, integrity_hash)
    VALUES (?, 'missing-batch', ?, 'project', ?, 'broken-step', ?, 'broken', 'broken')`)
    .run(randomUUID(), task.projectId, 'a'.repeat(64), taskId)
}
function syntheticExecution(task: ReturnType<typeof store.createTask>, employeeId: string, status: 'queued' | 'running' = 'queued', sessionId = '') {
  return store.createAgentExecution({ id: randomUUID(), projectId: task.projectId, entityType: 'task', entityId: task.id, agentId: employeeId, sessionId, prompt: '合成既有账本；不实际执行', status, startedAt: Date.now() })
}
function ledgerSnapshot(): string {
  const db = store.getProjectDb()
  return JSON.stringify(['agent_executions', 'controlled_task_preparations', 'pilot_commands', 'project_activities', 'agent_employee_learning_samples']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all()))
}

for (const profile of ['general', 'development', 'controlled'] as const) {
  for (const kind of ['marker', 'empty', 'link'] as const) {
    test(`Given ${profile}员工与${kind}残余且无grant When 陈旧Task走dispatch/IfIdle/controlled enqueue Then 队列与账本原样且零交接`, async () => {
      const { task, employee } = fixture(profile)
      const oldQueue = syntheticExecution(task, 'reassigned-old-employee')
      restrict(task.id, kind)
      const before = ledgerSnapshot(), calls = handoffCount
      expect(await employees.dispatchTaskToAgent(task)).toBeNull()
      expect(await employees.dispatchTaskToAgentIfIdle(task)).toBeNull()
      expect(() => employees.enqueueControlledPreparedTask(task.id)).toThrow('Owner')
      expect(store.getAgentExecution(oldQueue.id)?.status).toBe('queued')
      expect(store.getAgentEmployee(employee.id)?.runtime).toBe('claude')
      expect(ledgerSnapshot()).toBe(before)
      expect(handoffCount).toBe(calls)
    })
  }
}

test('Given 旧headless/Workflow队列已变Owner用途 When tryStart及heartbeat Then 不取消旧队列或创建session/worktree/Workflow', async () => {
  for (const workflow of [false, true]) {
    const { task, employee } = fixture()
    if (workflow) store.updateAgentEmployee(employee.id, { workflowId: 'must-not-read-workflow' })
    const execution = syntheticExecution(task, employee.id)
    restrict(task.id)
    const before = ledgerSnapshot(), calls = handoffCount
    expect(await employees.tryStartExecution(execution.id)).toBe(false)
    employees.scanAgentEmployeeHeartbeat()
    await Promise.resolve()
    expect(ledgerSnapshot()).toBe(before)
    expect(store.getAgentExecution(execution.id)).toMatchObject({ status: 'queued', sessionId: '' })
    expect(handoffCount).toBe(calls)
  }
})

test('Given 同session首条legacy第二Owner When legacy队列重用受限session Then 精确session证据优先拒绝', async () => {
  const { task, employee, project } = fixture()
  const sessionId = randomUUID()
  const first = syntheticExecution(task, employee.id, 'queued', sessionId)
  const secondTask = store.createTask(project.id, { title: '后来的业务步骤', description: '' })
  syntheticExecution(secondTask, employee.id, 'running', sessionId)
  restrict(secondTask.id, 'link')
  const calls = handoffCount
  expect(await employees.tryStartExecution(first.id)).toBe(false)
  expect(store.getAgentExecution(first.id)?.status).toBe('queued')
  expect(handoffCount).toBe(calls)
})

test('Given controlled旧确认/执行与坏Owner link When preview/assert/claim/start或请求幂等重入 Then 费用ack/status/existing-return之前拒绝', async () => {
  const { task, employee, project } = fixture('controlled')
  const execution = syntheticExecution(task, employee.id)
  const preparationId = randomUUID(), previewHash = 'b'.repeat(64)
  store.getProjectDb().prepare('UPDATE tasks SET controlled_preparation_id=? WHERE id=?').run(preparationId, task.id)
  store.getProjectDb().prepare(`INSERT INTO controlled_task_preparations
    (id,project_id,request_id,task_id,input_hash,actor,created_at,confirmed_preview_hash,execution_id)
    VALUES (?,?,?,?,?,'local-user',?,?,?)`).run(preparationId, project.id, 'synthetic-old-request', task.id, 'a'.repeat(64), Date.now(), previewHash, execution.id)
  restrict(task.id, 'link')
  const before = ledgerSnapshot(), original = store.getTask(task.id), calls = handoffCount
  expect(() => controlled.getControlledTaskStartPreview(task.id)).toThrow('Owner')
  expect(() => controlled.assertControlledPreparedExecution(execution.id)).toThrow('Owner')
  expect(() => controlled.assertControlledPreparedExecution(execution.id, 'provider')).toThrow('Owner')
  expect(() => controlled.claimControlledPreparedExecution(execution.id)).toThrow('Owner')
  for (const acknowledgeModelCosts of [false, true]) {
    await expect(controlled.startControlledTask({ taskId: task.id, previewHash, acknowledgeModelCosts })).rejects.toThrow('Owner')
  }
  expect(store.getTask(task.id)).toEqual(original)
  expect(ledgerSnapshot()).toBe(before)
  expect(handoffCount).toBe(calls)
})

test('Given existingTask受限且研发配置损坏 When 文件委派/范围/返工/Review验收 Then 普通patch及Review流转之前拒绝', async () => {
  const { task, employee, project } = fixture('development')
  restrict(task.id, 'empty')
  const scope = { workspaceId: 'missing-workspace', targetPaths: ['src/test.ts'], allowedPaths: ['src'] }
  const before = ledgerSnapshot(), original = store.getTask(task.id)
  expect(() => development.setTaskDevelopmentScope(task.id, scope, {}, { getWorkspace: () => undefined })).toThrow('Owner')
  expect(() => development.resolveDevelopmentDispatchScope(task, { getWorkspace: () => undefined })).toThrow('Owner')
  await expect(review.prepareFileDelegation({ projectId: project.id, employeeId: employee.id, existingTaskId: task.id, decisionIds: [], ...scope })).rejects.toThrow('Owner')
  await expect(review.requestChanges(task.id, '重新做')).rejects.toThrow('Owner')
  await expect(review.acceptDelivery(task.id, 'synthetic-delivery', { evidence: '不能借验收' })).rejects.toThrow('Owner')
  expect(store.getTask(task.id)).toEqual(original)
  expect(ledgerSnapshot()).toBe(before)
})

test('Given 同项目无关controlled身份未关联步骤 When 旧预检 Then 不用项目membership扩大business用途', async () => {
  const { project, task } = fixture('controlled')
  const owner = store.createTask(project.id, { title: '项目里的业务步骤', description: '' })
  restrict(owner.id)
  // 普通controlled身份仍由原准备门禁阻塞，不被误报Owner业务。
  expect(() => controlled.getControlledTaskStartPreview(task.id)).toThrow('不是待明确启动')
  expect(await employees.dispatchTaskToAgent(task)).toBeNull()
})

for (const outcome of ['complete', 'error', 'heartbeat'] as const) {
  test(`Given 合成交接之后出现Owner残余 When ${outcome}回调 Then 保留已有结果且不学习/交付/统计/普通完成`, async () => {
    const { task, employee } = fixture()
    const execution = syntheticExecution(task, employee.id)
    handoff = undefined
    expect(await employees.tryStartExecution(execution.id)).toBe(true)
    const captured = handoff!
    expect(captured).toBeDefined()
    store.updateAgentExecution(execution.id, { resultSummary: '原始历史保持' })
    restrict(task.id)
    const original = store.getTask(task.id), employeeBefore = store.getAgentEmployee(employee.id)
    const beforeSamples = store.listAgentEmployeeLearningSamples(employee.id)
    expect(() => captured.callbacks.onRunnerInvoke?.()).toThrow('Owner')
    if (outcome === 'complete') captured.callbacks.onComplete([{ id: randomUUID(), role: 'assistant', content: '不能升级成果', createdAt: Date.now() }])
    if (outcome === 'error') captured.callbacks.onError('不能记为普通负反馈')
    if (outcome === 'heartbeat') employees.scanAgentEmployeeHeartbeat()
    expect(store.getAgentExecution(execution.id)).toMatchObject({ status: 'stale', resultSummary: '原始历史保持' })
    expect(store.getTask(task.id)).toEqual(original)
    expect(store.listAgentEmployeeLearningSamples(employee.id)).toEqual(beforeSamples)
    expect(store.getAgentEmployee(employee.id)).toEqual(employeeBefore)
  })
}

test('Given 普通Task旧execution已有受限session残余 When IfIdle改派或controlled费用确认 Then 不清旧队列且ack之前拒绝', async () => {
  const { task, employee } = fixture('controlled')
  const sessionId = randomUUID()
  const execution = syntheticExecution(task, 'old-assignee', 'queued', sessionId)
  store.getProjectDb().prepare(`INSERT INTO project_owner_business_session_restrictions
    (session_id, execution_id, task_id, observed_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, execution.id, task.id, Date.now())
  const before = ledgerSnapshot()
  expect(await employees.dispatchTaskToAgentIfIdle(task)).toBeNull()
  expect(() => employees.enqueueControlledPreparedTask(task.id)).toThrow('Owner')
  expect(() => controlled.getControlledTaskStartPreview(task.id)).toThrow('Owner')
  const scope = { workspaceId: 'missing-workspace', targetPaths: ['src/test.ts'], allowedPaths: ['src'] }
  expect(() => development.setTaskDevelopmentScope(task.id, scope, {}, { getWorkspace: () => undefined })).toThrow('Owner')
  await expect(review.requestChanges(task.id, '不能沿旧session返工')).rejects.toThrow('Owner')
  await expect(review.acceptDelivery(task.id, 'synthetic-delivery', { evidence: '不能沿旧session验收' })).rejects.toThrow('Owner')
  await expect(controlled.startControlledTask({ taskId: task.id, previewHash: 'bad-old-preview', acknowledgeModelCosts: false })).rejects.toThrow('Owner')
  expect(store.getAgentExecution(execution.id)?.status).toBe('queued')
  expect(store.listAgentEmployeeLearningSamples(employee.id)).toEqual([])
  expect(ledgerSnapshot()).toBe(before)
})

test('Given 旧controlled prepare请求已指向Owner且员工配置损坏 When 幂等准备 Then purpose先于配置校验且不返回legacy结果', () => {
  const { task, employee, project } = fixture('controlled')
  const requestId = randomUUID()
  store.getProjectDb().prepare(`INSERT INTO controlled_task_preparations
    (id, project_id, request_id, task_id, input_hash, actor, created_at)
    VALUES (?, ?, ?, ?, ?, 'local-user', ?)`)
    .run(randomUUID(), project.id, requestId, task.id, 'a'.repeat(64), Date.now())
  restrict(task.id)
  const before = ledgerSnapshot()
  expect(() => controlled.prepareControlledTask({ requestId, projectId: project.id, employeeId: employee.id, workspaceId: 'missing-workspace', title: 'TEMP', description: '', priority: 'medium' })).toThrow('Owner')
  expect(ledgerSnapshot()).toBe(before)
})

test('Given 既有subTask execution在父Task后来出现用途残余 When tryStart Then 不沿子任务身份降级运行', async () => {
  const { task, employee, project } = fixture()
  const subTask = store.createExecutionSubTask(task.id, { title: '历史执行子任务' })!
  const execution = store.createAgentExecution({ id: randomUUID(), projectId: project.id, entityType: 'subTask', entityId: subTask.id, agentId: employee.id, sessionId: '', prompt: '异常历史，不运行', status: 'queued' })
  restrict(task.id, 'link')
  const before = ledgerSnapshot(), calls = handoffCount
  expect(await employees.tryStartExecution(execution.id)).toBe(false)
  employees.scanAgentEmployeeHeartbeat()
  expect(ledgerSnapshot()).toBe(before)
  expect(handoffCount).toBe(calls)
})

test('Given 受限Owner旧队列 When 用户明确取消 Then 仍可取消并保全而不生成学习或业务成果', () => {
  const { task, employee } = fixture()
  const execution = syntheticExecution(task, employee.id)
  restrict(task.id)
  const original = store.getTask(task.id)
  expect(employees.cancelAgentExecution(execution.id)).toMatchObject({ status: 'cancelled', stopped: true })
  expect(store.getAgentExecution(execution.id)?.status).toBe('cancelled')
  expect(store.getTask(task.id)).toEqual(original)
  expect(store.listAgentEmployeeLearningSamples(employee.id)).toEqual([])
})
