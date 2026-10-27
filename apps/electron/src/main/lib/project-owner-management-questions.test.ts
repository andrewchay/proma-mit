import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const directory = mkdtempSync(join(tmpdir(), 'owner-questions-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft, getProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const { saveOwnerRuntimeBinding, prepareOwnerPlanning } = await import('./project-owner-runtime-binding')
const { readOwnerPlanningSnapshot } = await import('./project-owner-planning-source')
const { ownerPlanningAdmissionHash } = await import('./project-owner-planning-provider')
const { recordOwnerPlanningRun } = await import('./project-owner-planning-run-service')
const { getOwnerManagementConversation, answerOwnerManagementQuestion, projectOwnerManagementRunResult } = await import('./project-owner-management-questions')
const { onOwnerManagementChanged } = await import('./project-owner-management-events')
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))
function fixture(taskScoped = false, rawResponse?: string) {
  const project = store.createProject({ title: '必要协商', description: '' })
  const workspace = createAgentWorkspace(`问题-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假模型', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: 'Owner载体', role: '规划', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const taskId = taskScoped ? store.createTask(project.id, { title: '单任务', description: '' }).id : undefined
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '给出定位建议', constraints: ['保留原约束'] }, taskId)
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '隔离绑定' })
  const context = getProjectOwnerPlanningContext(project.id, taskId)
  const link = prepareOwnerPlanning(project.id, { requestId: randomUUID(), ...(taskId ? { taskId } : {}), expectedBindingRevision: 1, expectedGoalRevision: 1, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint })
  const executionId = randomUUID(), sessionId = randomUUID()
  store.createAgentExecution({ id: executionId, projectId: project.id, entityType: 'task', entityId: link.planningTaskId, agentId: employee.id, sessionId, status: 'running', prompt: '隔离回调夹具' })
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, link.planningTaskId)
  // 合成准入只用于验证可信回调、问题与答复链；不声称真实Provider或费用授权。
  const admission = { link_id: link.id, execution_id: executionId, session_id: sessionId, request_hash: 'a'.repeat(64), source_snapshot: JSON.stringify(readOwnerPlanningSnapshot(link.planningTaskId)!.context), admitted_at: Date.now() }
  store.getProjectDb().prepare('INSERT INTO project_owner_planning_admissions (link_id, execution_id, session_id, request_hash, source_snapshot, admitted_at, integrity_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(admission.link_id, executionId, sessionId, admission.request_hash, admission.source_snapshot, admission.admitted_at, ownerPlanningAdmissionHash(admission))
  const response = { schemaVersion: 1, kind: 'needs_clarification', projectId: project.id, ...(taskId ? { taskId } : {}), goalVersion: 1, contextFingerprint: context.fingerprint, reason: '受众决定方案取舍', questions: [{ key: 'audience', reasonType: 'missing_information', question: '主要服务谁？', why: '决定定位范围', options: ['新用户', '现有用户'], recommended: '现有用户' }] }
  const result = { type: 'result' as const, subtype: 'success' as const, session_id: sessionId, finish_reason: 'stop' as const, result: rawResponse ?? JSON.stringify(response), usage: { input_tokens: 0, output_tokens: 0 } }
  recordOwnerPlanningRun(executionId, 'ai-sdk', result)
  return { project, taskId, executionId, result, context, link }
}

test('Given Owner响应格式无效 When写回规划结果 Then对话显示具体协议失败原因', () => {
  const f = fixture(false, '{"schemaVersion":1,}')
  projectOwnerManagementRunResult(f.project.id, f.executionId, randomUUID())
  const message = getOwnerManagementConversation(f.project.id).messages.findLast(item => item.kind === 'attention')
  expect(message?.content).toContain('失败原因：Owner规划响应不是有效JSON')
})

function questionInput(f: ReturnType<typeof fixture>) {
  const question = getOwnerManagementConversation(f.project.id).questions.find(item => item.executionId === f.executionId)!
  return { projectId: f.project.id, questionId: question.id, requestId: randomUUID(), expectedGoalRevision: question.goalRevision, expectedContextFingerprint: question.contextFingerprint, answers: { audience: '现有用户' } }
}

test('Given 模型提出必要问题 When 页面未挂载且应用重开 Then 后台生成可恢复的问题与主动消息，重复回调不重复', async () => {
  const f = fixture()
  store.closeProjectDb(); await store.initProjectDb()
  const stop = startOwnerManagementLoop()
  try {
    const first = getOwnerManagementConversation(f.project.id)
    expect(first.questions).toHaveLength(1)
    expect(first.questions[0]).toMatchObject({ state: 'open', reason: '受众决定方案取舍', questions: [{ key: 'audience', recommended: '现有用户' }] })
    expect(first.messages.filter(message => message.kind === 'clarification')).toHaveLength(1)
    recordOwnerPlanningRun(f.executionId, 'ai-sdk', f.result)
    await tick()
    expect(getOwnerManagementConversation(f.project.id).questions).toEqual(first.questions)
    expect(getOwnerManagementConversation(f.project.id).messages.filter(message => message.kind === 'clarification')).toHaveLength(1)
  } finally { stop() }
})

test('Given 原问题有效 When 答复并重复提交 Then 同事务保存约束与答复，后台自动准备下一轮且无补发模型', async () => {
  const f = fixture()
  reconcileOwnerManagement(f.project.id)
  const input = questionInput(f)
  const stop = startOwnerManagementLoop()
  try {
    const saved = answerOwnerManagementQuestion(input)
    expect(saved.revision).toBe(2)
    expect(saved.goal.constraints).toEqual(['保留原约束', 'Owner澄清答复（主要服务谁？）：现有用户'])
    expect(answerOwnerManagementQuestion(input)).toEqual(saved)
    expect(() => answerOwnerManagementQuestion({ ...input, answers: { audience: '不同答案' } })).toThrow('已有不同答复')
    await tick()
    const view = getOwnerManagementConversation(f.project.id)
    expect(view.questions[0]?.state).toBe('answered')
    expect(view.messages.filter(message => message.kind === 'answer')).toHaveLength(1)
    const next = view.messages.findLast(message => message.kind === 'planning_confirmation')
    expect(next?.planningTaskId).toBeTruthy()
    expect(next?.planningTaskId).not.toBe(f.link.planningTaskId)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    expect(store.getTask(next!.planningTaskId!)?.status).toBe('paused')
  } finally { stop() }
})

test('Given 来源已漂移或项目不匹配 When 套用旧答复 Then 拒绝且不改变目标或创建新准备', () => {
  const f = fixture(); reconcileOwnerManagement(f.project.id)
  const input = questionInput(f)
  const other = store.createProject({ title: '其他项目', description: '' })
  expect(() => answerOwnerManagementQuestion({ ...input, projectId: other.id })).toThrow('不属于')
  expect(() => answerOwnerManagementQuestion({ ...input, expectedContextFingerprint: '0'.repeat(64) })).toThrow('来源已变化')
  saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '已改变的目标' })
  expect(getOwnerManagementConversation(f.project.id).questions[0]?.state).toBe('stale')
  expect(() => answerOwnerManagementQuestion(input)).toThrow()
  expect(getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(2)
  expect(store.listTasks(f.project.id)).toHaveLength(1)
})

test('Given 不完整或夹带授权的答复 When 保存 Then 严格拒绝且旧问题继续开放', () => {
  const f = fixture(); reconcileOwnerManagement(f.project.id)
  const input = questionInput(f)
  for (const patch of [{ answers: {} }, { answers: { audience: '' } }, { answers: { audience: '现有用户', fake: 'x' } }, { actor: 'system' }, { grantId: 'fake' }]) expect(() => answerOwnerManagementQuestion({ ...input, ...patch })).toThrow()
  expect(getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(1)
  expect(getOwnerManagementConversation(f.project.id).questions[0]?.state).toBe('open')
})

test('Given 用户答复事务被回滚 When 重新读取 Then 约束、答复与后续事件都不半写，仍可正常回答', async () => {
  const f = fixture(); reconcileOwnerManagement(f.project.id)
  const input = questionInput(f)
  const stop = startOwnerManagementLoop()
  try {
    expect(() => store.getProjectDb().transaction(() => { answerOwnerManagementQuestion(input); throw new Error('rollback') })()).toThrow('rollback')
    await tick()
    expect(getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(1)
    expect(getOwnerManagementConversation(f.project.id).questions[0]?.state).toBe('open')
    expect(store.listTasks(f.project.id)).toHaveLength(1)
    expect(answerOwnerManagementQuestion(input).revision).toBe(2)
  } finally { stop() }
})

test('Given 任务级问题 When 回答 Then 只修订准确任务目标，项目目标不被补造', async () => {
  const f = fixture(true); reconcileOwnerManagement(f.project.id)
  const stop = startOwnerManagementLoop()
  try {
    answerOwnerManagementQuestion(questionInput(f)); await tick()
    expect(getProjectOwnerGoalDraft(f.project.id, f.taskId)?.revision).toBe(2)
    expect(getProjectOwnerGoalDraft(f.project.id)).toBeNull()
    expect(getOwnerManagementConversation(f.project.id).questions[0]?.state).toBe('answered')
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
  } finally { stop() }
})


test('Given 旧问题来源仍同但已有更新规划请求 When 回答旧问题 Then 标记stale并拒绝旧答复', () => {
  const f = fixture(); reconcileOwnerManagement(f.project.id)
  const input = questionInput(f)
  prepareOwnerPlanning(f.project.id, { requestId: randomUUID(), expectedBindingRevision: 1, expectedGoalRevision: 1, expectedPlanRevision: 0, expectedContextFingerprint: f.context.fingerprint })
  expect(getOwnerManagementConversation(f.project.id).questions[0]?.state).toBe('stale')
  expect(() => answerOwnerManagementQuestion(input)).toThrow('更新的问题')
  expect(getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(1)
})

test('Given 答复消息写入后外层回滚 When 发送主进程推送 Then 不通知未提交消息', async () => {
  const f = fixture(); reconcileOwnerManagement(f.project.id); await tick()
  const input = questionInput(f)
  const changes: { projectId: string; messageId?: string }[] = []
  const off = onOwnerManagementChanged(change => { if (change.projectId === f.project.id) changes.push(change) })
  try {
    expect(() => store.getProjectDb().transaction(() => { answerOwnerManagementQuestion(input); throw new Error('rollback') })()).toThrow('rollback')
    await tick()
    expect(changes).toHaveLength(0)
    answerOwnerManagementQuestion(input); await tick()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.messageId).toBeDefined()
  } finally { off() }
})

test('Given仍开放的必要问题 When同目标下继续普通对话 Then不因聊天请求本身令原问题过期', async () => {
  const f = fixture(); reconcileOwnerManagement(f.project.id)
  const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
  const view = getOwnerManagementConversation(f.project.id)
  sendOwnerManagementMessage({ projectId: f.project.id, conversationId: view.manager!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '可以先解释为什么需要这个信息吗？' })
  reconcileOwnerManagement(f.project.id)
  expect(getOwnerManagementConversation(f.project.id).questions.find(item => item.executionId === f.executionId)?.state).toBe('open')
})
