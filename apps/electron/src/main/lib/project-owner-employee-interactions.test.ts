import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const directory = mkdtempSync(join(tmpdir(), 'owner-interactions-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
const store = await import('./project-sqlite-store')
const service = await import('./project-owner-employee-interactions')
const askUserModule = await import('./agent-ask-user-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
let ordinal = 0
function fixture(kind: 'question' | 'permission' = 'question') {
  const suffix = String(++ordinal), project = store.createProject({ title: '员工交互', description: '' })
  const sessionId = `session-${suffix}`, executionId = `execution-${suffix}`, commandId = `command-${suffix}`, taskId = `task-${suffix}`
  store.getProjectDb().prepare(`INSERT INTO agent_executions(id,project_id,entity_type,entity_id,agent_id,session_id,status,started_at,owner_command_id) VALUES(?,?,'task',?,'employee',?,'running',?,?)`).run(executionId, project.id, taskId, sessionId, Date.now(), commandId)
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_commands(id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,employee_id,role,rework_ordinal,reserved_cost_micros,state,execution_id,ack_fingerprint,created_at,updated_at) VALUES(?,?,'grant',?,?,'step',1,'hash','employee','executor',0,1,'running',?,'ack',1,1)`).run(commandId, project.id, suffix, taskId, executionId)
  const input = { sessionId, requestId: `request-${suffix}`, kind, toolInput: { questions: [] }, questions: [], summary: '需要确认颜色' }
  return { input, record: service.createOwnerEmployeeInteraction(input) }
}
const decision = { source: 'owner' as const, sourceMessageId: 'message', action: 'answer' as const, answers: { color: '蓝色' }, reason: '符合已确认品牌规范' }
test('员工问题只登记一次，重用请求但改变内容必须拒绝', () => {
  const { input, record } = fixture()
  expect(service.createOwnerEmployeeInteraction(input)).toEqual(record)
  expect(() => service.createOwnerEmployeeInteraction({ ...input, summary: '改问题' })).toThrow('不同内容')
  expect(service.getOwnerEmployeeInteraction('other-project', record.id)).toBeNull()
})
test('经讨论定案和投递后结束，旧修订与重复投递不被接受', () => {
  let { record } = fixture()
  const next = (state: typeof record.state, selected?: typeof decision) => service.transitionOwnerEmployeeInteraction({ projectId: record.projectId, id: record.id, expectedRevision: record.revision, state, ...(selected ? { decision: selected } : {}) })
  record = next('discussing_user'); record = next('decided', decision); record = next('delivering'); record = next('resolved')
  expect(record.revision).toBe(5)
  expect(() => next('delivering')).toThrow('状态转换')
  expect(() => service.transitionOwnerEmployeeInteraction({ projectId: record.projectId, id: record.id, expectedRevision: 1, state: 'cancelled' })).toThrow('已更新')
})
test('Owner不得代签权限，用户决定才能登记', () => {
  const { record } = fixture('permission')
  const input = { projectId: record.projectId, id: record.id, expectedRevision: 1, state: 'decided' as const }
  expect(() => service.transitionOwnerEmployeeInteraction({ ...input, decision })).toThrow('不得代用户')
  expect(service.transitionOwnerEmployeeInteraction({ ...input, decision: { ...decision, source: 'user' } }).state).toBe('decided')
})
test('员工结束不能回流；可登记失效但不能重启旧请求', () => {
  const { record } = fixture()
  store.getProjectDb().prepare("UPDATE agent_executions SET status='completed' WHERE id=?").run(record.executionId)
  const input = { projectId: record.projectId, id: record.id, expectedRevision: 1 }
  expect(() => service.transitionOwnerEmployeeInteraction({ ...input, state: 'decided', decision })).toThrow('运行中的')
  expect(service.transitionOwnerEmployeeInteraction({ ...input, state: 'stale' }).state).toBe('stale')
})

test('Given重启后原等待Promise丢失 When扫描 Then仅标失联且重复扫描不重复修订', () => {
  const { record } = fixture()
  service.reconcileLostOwnerEmployeeInteractions(record.projectId)
  const stale = service.getOwnerEmployeeInteraction(record.projectId, record.id)!
  expect(stale.state).toBe('stale')
  expect(stale.revision).toBe(2)
  expect(service.reconcileLostOwnerEmployeeInteractions(record.projectId)).toBe(0)
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)).toEqual(stale)
})

test('Given员工等待Owner When超过期限 Then拒绝原等待并只登记一次超时说明', () => {
  const { record } = fixture()
  expect(record.expiresAt).toBe(record.createdAt + service.OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS)
  expect(service.expireOwnerEmployeeInteractions(record.projectId, record.expiresAt! - 1)).toBe(0)
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)?.state).toBe('pending_owner')
  expect(service.expireOwnerEmployeeInteractions(record.projectId, record.expiresAt!)).toBe(1)
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)?.state).toBe('stale')
  expect(service.expireOwnerEmployeeInteractions(record.projectId, record.expiresAt! + 1)).toBe(0)
})

test('Given仍在等待的原请求 When等待到期拒绝 ThenPromise收到deny且不能改写为允许', async () => {
  let requestId = ''
  const askUser = new askUserModule.AgentAskUserService({ route: request => { requestId = request.requestId; return true }, cancel: () => {} })
  const waiting = askUser.handleAskUserQuestion('session-timeout', { questions: [{ question: '颜色', options: [] }] }, new AbortController().signal, () => {})
  expect(askUser.hasOwnerPendingRequest(requestId, 'session-timeout')).toBe(true)
  expect(askUser.expireOwnerAskUser(requestId, 'other-session', '超时')).toBe(false)
  expect(askUser.expireOwnerAskUser(requestId, 'session-timeout', '等待Owner答复已超时')).toBe(true)
  const result = await waiting
  expect(result.behavior).toBe('deny')
  expect(result.behavior === 'deny' ? result.message : '').toContain('超时')
  expect(askUser.hasOwnerPendingRequest(requestId, 'session-timeout')).toBe(false)
  expect(askUser.expireOwnerAskUser(requestId, 'session-timeout', '重复')).toBe(false)
})

test('Given事项已转给用户决定 When超过期限 Then不作废且保留待决', () => {
  let { record } = fixture()
  record = service.transitionOwnerEmployeeInteraction({ projectId: record.projectId, id: record.id, expectedRevision: record.revision, state: 'discussing_user' })
  const far = record.createdAt + service.OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS * 10
  expect(service.expireOwnerEmployeeInteractions(record.projectId, far)).toBe(0)
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)).toMatchObject({ state: 'discussing_user', revision: record.revision })
})

test('Given关联授权已暂停 When事项等待用户决定 Then不清除待决也不抛错', () => {
  let { record } = fixture()
  record = service.transitionOwnerEmployeeInteraction({ projectId: record.projectId, id: record.id, expectedRevision: record.revision, state: 'discussing_user' })
  store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id='grant'").run()
  const far = record.createdAt + service.OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS * 10
  expect(service.expireOwnerEmployeeInteractions(record.projectId, far)).toBe(0)
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)?.state).toBe('discussing_user')
})

test('Given缺少截止字段的旧记录 When扫描 Then按创建时间推算且不无限等待', () => {
  const { record } = fixture()
  const legacy = { ...record, expiresAt: undefined }
  const deadline = legacy.createdAt + service.OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS
  expect(service.expireOwnerEmployeeInteractions(record.projectId, deadline - 1)).toBe(0)
  expect(service.expireOwnerEmployeeInteractions(record.projectId, deadline)).toBe(1)
  expect(service.expireOwnerEmployeeInteractions(record.projectId, deadline + 1)).toBe(0)
})

test('Given超时收尾 When重复对账 Then不重建等待也不把失联改成成功', () => {
  const { record } = fixture()
  expect(service.expireOwnerEmployeeInteractions(record.projectId, denyClock(record))).toBe(1)
  const stale = service.getOwnerEmployeeInteraction(record.projectId, record.id)!
  expect(stale.revision).toBe(2)
  expect(service.reconcileLostOwnerEmployeeInteractions(record.projectId)).toBe(0)
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)).toEqual(stale)
  expect(service.listOwnerEmployeeInteractions(record.projectId).filter(item => item.id === record.id)).toHaveLength(1)
})
function denyClock(record: { expiresAt?: number; createdAt: number }): number {
  return (record.expiresAt ?? record.createdAt + service.OWNER_EMPLOYEE_INTERACTION_TIMEOUT_MS) + 1
}

test('Given关联执行已由启动恢复收尾 When登记失联 Then说明真实终态且不伪造停止', () => {
  const { record } = fixture()
  store.getProjectDb().prepare("UPDATE agent_executions SET status='stale' WHERE id=?").run(record.executionId)
  expect(service.reconcileLostOwnerEmployeeInteractions(record.projectId)).toBe(1)
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)?.state).toBe('stale')
})
test('Given关联执行仍在运行 When登记失联 Then保留未知占额并提示未确认结束', () => {
  const { record } = fixture()
  expect(store.getAgentExecution(record.executionId)?.status).toBe('running')
  expect(service.reconcileLostOwnerEmployeeInteractions(record.projectId)).toBe(1)
  expect(store.getAgentExecution(record.executionId)?.status).toBe('running')
  expect(service.getOwnerEmployeeInteraction(record.projectId, record.id)?.state).toBe('stale')
})

test('Given 员工提出两个原文相同的问题 When 登记 Then 生成稳定问题ID且可分别作答', () => {
  const project = store.createProject({ title: '重复问题', description: '' })
  const sessionId = `session-dup-${Date.now()}`, executionId = `execution-dup-${Date.now()}`, commandId = `command-dup-${Date.now()}`, taskId = `task-dup-${Date.now()}`
  store.getProjectDb().prepare(`INSERT INTO agent_executions(id,project_id,entity_type,entity_id,agent_id,session_id,status,started_at,owner_command_id) VALUES(?,?,'task',?,'employee',?,'running',?,?)`).run(executionId, project.id, taskId, sessionId, Date.now(), commandId)
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_commands(id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,employee_id,role,rework_ordinal,reserved_cost_micros,state,execution_id,ack_fingerprint,created_at,updated_at) VALUES(?,?,'grant',?,?,'step',1,'hash','employee','executor',0,1,'running',?,'ack',1,1)`).run(commandId, project.id, commandId, taskId, executionId)
  const record = service.createOwnerEmployeeInteraction({ sessionId, requestId: `request-dup-${Date.now()}`, kind: 'question', toolInput: {}, questions: [{ question: '颜色', options: [] }, { question: '颜色', options: [] }], summary: '两个同名问题' })
  expect(service.ownerEmployeeQuestionKeys(record.questions)).toEqual(['q1', 'q2'])
  const byText = service.resolveOwnerEmployeeAnswers(record.questions, { 颜色: '蓝色' })
  expect(byText).toEqual({ 颜色: '蓝色' })
  const byId = service.resolveOwnerEmployeeAnswers(record.questions, { q1: '蓝色', q2: '绿色' })
  expect(byId).toEqual({ 颜色: '绿色' })
  expect(() => service.resolveOwnerEmployeeAnswers(record.questions, { q1: '蓝色' })).toThrow('全部问题')
  expect(() => service.resolveOwnerEmployeeAnswers(record.questions, { q1: '蓝色', q2: '绿色', q3: '多余' })).toThrow('原请求之外')
})

test('Given 两个员工同时超时 When 到期核对 Then 只写一条合并说明且逐项保留', () => {
  const project = store.createProject({ title: '合并通知', description: '' })
  const suffix = Date.now()
  const make = (index: number) => {
    const sessionId = `session-batch-${suffix}-${index}`, executionId = `execution-batch-${suffix}-${index}`, commandId = `command-batch-${suffix}-${index}`, taskId = `task-batch-${suffix}-${index}`
    store.getProjectDb().prepare(`INSERT INTO agent_executions(id,project_id,entity_type,entity_id,agent_id,session_id,status,started_at,owner_command_id) VALUES(?,?,'task',?,'employee',?,'running',?,?)`).run(executionId, project.id, taskId, sessionId, Date.now(), commandId)
    store.getProjectDb().prepare(`INSERT INTO project_owner_execution_commands(id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,employee_id,role,rework_ordinal,reserved_cost_micros,state,execution_id,ack_fingerprint,created_at,updated_at) VALUES(?,?,'grant',?,?,'step',1,'hash','employee','executor',0,1,'running',?,'ack',1,1)`).run(commandId, project.id, commandId, taskId, executionId)
    return service.createOwnerEmployeeInteraction({ sessionId, requestId: `request-batch-${suffix}-${index}`, kind: 'question', toolInput: {}, questions: [{ question: `问题${index}`, options: [] }], summary: `员工问题${index}` })
  }
  const first = make(1), second = make(2)
  const goals = require('./project-owner-goal-service') as typeof import('./project-owner-goal-service')
  const management = require('./project-owner-management-store') as typeof import('./project-owner-management-store')
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '合并通知目标', constraints: [], acceptanceCriteria: [] }))
  const now = Math.max(first.expiresAt!, second.expiresAt!) + 1
  expect(service.expireOwnerEmployeeInteractions(project.id, now)).toBe(2)
  const messages = management.getOwnerManagementView(project.id).messages.filter(item => item.kind === 'attention' && item.content.includes('员工提问等待我答复超过期限'))
  expect(messages).toHaveLength(1)
  expect(messages[0]!.content).toContain('2 项')
  expect(messages[0]!.content).toContain('员工问题1')
  expect(messages[0]!.content).toContain('员工问题2')
  expect(service.getOwnerEmployeeInteraction(project.id, first.id)?.state).toBe('stale')
  expect(service.getOwnerEmployeeInteraction(project.id, second.id)?.state).toBe('stale')
  // 同一批重复核对不再产生新说明。
  expect(service.expireOwnerEmployeeInteractions(project.id, now + 1000)).toBe(0)
  expect(management.getOwnerManagementView(project.id).messages.filter(item => item.kind === 'attention' && item.content.includes('员工提问等待我答复超过期限'))).toHaveLength(1)
})
