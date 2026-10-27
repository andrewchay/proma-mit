import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
const directory = mkdtempSync(join(tmpdir(), 'owner-changes-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const goals = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const { saveOwnerRuntimeBinding, getOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { resolveOwnerPlanningSession, readOwnerPlanningSnapshot, resolveOwnerPlanningTask } = await import('./project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const delegation = await import('./project-owner-management-delegation')
const { getOwnerManagementConversation } = await import('./project-owner-management-questions')
const { getOwnerManager, setOwnerManagerStatus } = await import('./project-owner-management-store')
const { sendOwnerManagementMessage, withOwnerConversationContext } = await import('./project-owner-management-conversation')
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
const { setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')
const { parseProjectOwnerPlanningResponse } = await import('./project-owner-planning-protocol')
const changes = await import('./project-owner-management-changes')
const callbacks = new Map<string, HeadlessAgentRunCallbacks>()
beforeAll(async () => {
  await store.initProjectDb()
  setHeadlessAgentRunner(async (input, handlers) => {
    const source = resolveOwnerPlanningSession(input.sessionId)!
    claimOwnerPlanningProviderRequest(input.sessionId, JSON.stringify({ model: source.binding.modelId, stream: true, max_tokens: source.link.maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: source.request.systemPrompt }, { role: 'user', content: source.request.userPrompt }] }), new URL('https://example.invalid/v1/chat/completions'))
    callbacks.set(input.sessionId, handlers)
  })
})
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(taskScoped = false) {
  const project = store.createProject({ title: '同一项目对话', description: '' })
  const workspace = createAgentWorkspace(`对话-${randomUUID()}`); bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: 'Owner', role: '规划', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  const taskId = taskScoped ? store.createTask(project.id, { title: '单任务目标', description: '' }).id : undefined
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成产品定位建议' }, taskId)
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  reconcileOwnerManagement(project.id)
  const subject = { projectId: project.id, ...(taskId ? { taskId } : {}) }
  const message = (content: string) => ({ ...subject, conversationId: getOwnerManager(project.id)!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content })
  const issue = () => {
    const input = { ...subject, requestId: randomUUID(), maxRequests: 6, maxCostMicros: 20_000_000, expiresAt: Date.now() + 3600000 }
    const preview = delegation.previewOwnerManagementDelegation(input)
    return delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
  }
  return { project, taskId, subject, message, issue }
}
async function until(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('等待后台对话超时') }
function active(f: ReturnType<typeof fixture>) { return store.listAgentExecutionsByProject(f.project.id).find(item => item.status === 'running' && callbacks.has(item.sessionId!)) }
function finish(f: ReturnType<typeof fixture>, kind: 'reply' | 'plan' | 'clarify' = 'reply') {
  const execution = active(f)!, source = resolveOwnerPlanningSession(execution.sessionId!)!
  const binding = { projectId: f.project.id, ...(f.taskId ? { taskId: f.taskId } : {}), goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }
  const result = kind === 'clarify' ? { schemaVersion: 1, kind: 'needs_clarification', binding, reason: '受众会改变定位', questions: [{ key: 'audience', reasonType: 'missing_information', question: '主要服务谁？', why: '确定定位', options: ['新用户', '现有用户'] }] } : kind === 'reply' ? { schemaVersion: 1, kind: 'conversation_reply', binding, messageId: source.context.conversation!.throughMessageId, message: '目前仍在方案讨论阶段，尚无真实成果证据。' } : { schemaVersion: 1, kind: 'plan_proposal', binding, proposal: { summary: '按反馈收敛方案', assumptions: [], risks: [], steps: [{ key: 'brief', title: '定位建议', outcome: '一页建议', acceptanceCriteria: ['说明取舍'], dependencies: [], roleKey: source.context.sources.roles[0]!.key }] } }
  callbacks.get(execution.sessionId!)!.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId!, finish_reason: 'stop', result: JSON.stringify(result), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
  return execution
}

async function changed(f: ReturnType<typeof fixture>, make: (source: NonNullable<ReturnType<typeof resolveOwnerPlanningSession>>) => import('@gravitas/shared').OwnerConversationChange) {
  await until(() => Boolean(active(f)))
  const execution = active(f)!, source = resolveOwnerPlanningSession(execution.sessionId!)!
  const response = { schemaVersion: 1, kind: 'conversation_change', binding: { projectId: f.project.id, ...(f.taskId ? { taskId: f.taskId } : {}), goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }, messageId: source.link.conversationMessageId, message: '我理解为以下内容，请确认。', change: make(source) }
  callbacks.get(execution.sessionId!)!.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId!, finish_reason: 'stop', result: JSON.stringify(response), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
  await until(() => changes.listOwnerConversationChanges(f.project.id).length > 0)
  return changes.listOwnerConversationChanges(f.project.id).at(-1)!
}
const revised = () => ({ kind: 'goal_revision' as const, goal: { objective: '形成面向现有用户的定位建议', constraints: ['限一页', '不联网'], acceptanceCriteria: ['明确取舍'] } })
function decision(view: import('@gravitas/shared').OwnerConversationChangeView, action: 'apply' | 'dismiss' = 'apply') { return { projectId: view.projectId, changeId: view.id, requestId: randomUUID(), action, previewHash: view.previewHash } }

test('Given同框答复开放问题 When理解提案确认 Then复用答复谱系自动续跑且不发业务许可', async () => {
  const f = fixture(), grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f))); finish(f, 'clarify')
    await until(() => getOwnerManagementConversation(f.project.id).questions.some(item => item.state === 'open'))
    const question = getOwnerManagementConversation(f.project.id).questions[0]!
    sendOwnerManagementMessage(f.message('主要给现有用户，按这个来规划'))
    const view = await changed(f, source => {
      expect(source.context.conversation?.interactionVersion).toBe(2)
      expect(source.context.conversation?.openQuestions).toMatchObject([{ id: question.id }])
      return { kind: 'clarification_answers', questionId: question.id, answers: { audience: '现有用户' } }
    })
    expect(view).toMatchObject({ state: 'pending', questions: [{ key: 'audience', question: '主要服务谁？' }] })
    expect(goals.getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(1)
    const input = decision(view), saved = changes.decideOwnerConversationChange(input)
    expect(saved.goal).toMatchObject({ revision: 2, goal: { constraints: ['Owner澄清答复（主要服务谁？）：现有用户'] } })
    expect(changes.decideOwnerConversationChange(input)).toEqual(saved)
    await until(() => Boolean(active(f)))
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 3 })
    finish(f, 'plan')
    await until(() => plans.getProjectOwnerPlanDraft(f.project.id)?.state === 'proposed')
    expect(changes.getOwnerConversationChange(f.project.id, view.id).state).toBe('applied')
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ c: 0 })
    expect(getOwnerManagementConversation(f.project.id).questions[0]?.state).toBe('answered')
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given目标修订建议 When明确确认、数据库重开与丢回包重提 Then只更新一次并撤销旧委托、不扩大授权', async () => {
  const f = fixture(true)
  goals.saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '先面向新用户的定位建议', codeSourceAccess: 'none' }, f.taskId)
  sendOwnerManagementMessage({ ...f.message('目标改成面向现有用户，限一页不联网'), expectedGoalRevision: 2 })
  const grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    const view = await changed(f, revised), input = decision(view)
    expect(goals.getProjectOwnerGoalDraft(f.project.id, f.taskId)?.revision).toBe(2)
    const result = changes.decideOwnerConversationChange(input)
    expect(result.goal).toMatchObject({ revision: 3, goal: { ...revised().goal, codeSourceAccess: 'none', taskId: f.taskId } })
    expect(delegation.getOwnerManagementDelegation(f.project.id, f.taskId).state).toBe('revoked')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    store.closeProjectDb(); await store.initProjectDb()
    expect(changes.decideOwnerConversationChange(input)).toEqual(result)
    goals.saveProjectOwnerGoalDraft(f.project.id, 3, { objective: '之后手工调整的目标' }, f.taskId)
    expect(changes.decideOwnerConversationChange(input)).toEqual(result)
    expect(goals.getProjectOwnerGoalDraft(f.project.id, f.taskId)?.revision).toBe(4)
    expect(() => changes.decideOwnerConversationChange({ ...input, action: 'dismiss' })).toThrow('不同裁决')
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'change_decision')).toHaveLength(1)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given理解有误 When暂不采用 Then保留原目标、管理委托和对话且不新增模型请求', async () => {
  const f = fixture(); sendOwnerManagementMessage(f.message('讨论是否调整目标'))
  const grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    const view = await changed(f, revised), before = goals.getProjectOwnerGoalDraft(f.project.id)
    expect(changes.decideOwnerConversationChange(decision(view, 'dismiss'))).toEqual({ changeId: view.id, action: 'dismiss' })
    expect(goals.getProjectOwnerGoalDraft(f.project.id)).toEqual(before)
    expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('active')
    expect(changes.getOwnerConversationChange(f.project.id, view.id).state).toBe('dismissed')
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given较新消息、目标、方案或配置变化 When应用旧理解 Then拒绝旧目标修改且不撤销委托', async () => {
  for (const reason of ['message', 'goal', 'plan', 'binding'] as const) {
    const f = fixture(); sendOwnerManagementMessage(f.message('修订定位目标'))
    const grant = f.issue(), stop = startOwnerManagementLoop()
    try {
      const view = await changed(f, revised)
      setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
      if (reason === 'message') sendOwnerManagementMessage(f.message('等等，还要再讨论'))
      if (reason === 'goal') goals.saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '新的目标' })
      if (reason === 'binding') { const binding = getOwnerRuntimeBinding(f.project.id)!; saveOwnerRuntimeBinding(f.project.id, 1, { carrierId: binding.carrierId, workspaceId: binding.workspaceId, ownerName: '新名称', changeReason: '新的绑定' }) }
      if (reason === 'plan') {
        const context = plans.getProjectOwnerPlanningContext(f.project.id)
        plans.saveProjectOwnerPlanDraft(f.project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '新的方案', assumptions: [], risks: [], steps: [{ key: 'brief', title: '建议', outcome: '报告', acceptanceCriteria: ['可读'], dependencies: [], roleKey: context.sources.roles[0]!.key }], changeReason: '更新' })
      }
      expect(changes.getOwnerConversationChange(f.project.id, view.id).state).toBe('stale')
      expect(() => changes.decideOwnerConversationChange(decision(view))).toThrow('旧理解')
      expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'change_decision')).toBe(false)
    } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
  }
})

test('Given跨项目、篡改摘要或夹带权限的裁决 When提交 Then不修改权威目标、外层回滚无副作用', async () => {
  const f = fixture(); sendOwnerManagementMessage(f.message('修改目标'))
  const grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    const view = await changed(f, revised), input = decision(view), other = fixture()
    for (const invalid of [{ ...input, projectId: other.project.id }, { ...input, previewHash: 'a'.repeat(64) }, { ...input, actor: 'admin' }, { ...input, goal: revised().goal }, { ...input, grant: true }]) expect(() => changes.decideOwnerConversationChange(invalid)).toThrow()
    expect(() => store.getProjectDb().transaction(() => { changes.decideOwnerConversationChange(input); throw new Error('外层回滚') })()).toThrow('外层回滚')
    expect(goals.getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(1)
    expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('active')
    expect(changes.getOwnerConversationChange(f.project.id, view.id).state).toBe('pending')
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given意图协议 When不完整答案、伪造问题/权限、无变化目标或历史协议响应 Then严格拒绝且保留旧提示', () => {
  const f = fixture(), context = plans.getProjectOwnerPlanningContext(f.project.id), message = sendOwnerManagementMessage(f.message('需要修改'))
  const current = withOwnerConversationContext(context, message.id), legacy = withOwnerConversationContext(context, message.id, undefined, 1)
  const response = { kind: 'conversation_change', binding: { projectId: f.project.id, goalVersion: 1, contextFingerprint: context.fingerprint }, messageId: message.id, message: '请确认', change: revised() }
  expect(parseProjectOwnerPlanningResponse(response, current).kind).toBe('conversation_change')
  expect(() => parseProjectOwnerPlanningResponse(response, legacy)).toThrow('协议')
  const { buildProjectOwnerPlanningRequest } = require('./project-owner-planning-protocol') as typeof import('./project-owner-planning-protocol')
  expect(buildProjectOwnerPlanningRequest(legacy).systemPrompt).not.toContain('conversation_change')
  const withQuestion = { ...current, conversation: { ...current.conversation!, openQuestions: [{ id: 'b'.repeat(64), goalRevision: 1, contextFingerprint: context.fingerprint, reason: '需要决定', questions: [{ key: 'a', reasonType: 'missing_information' as const, question: '受众？', why: '决定定位', options: [] }, { key: 'b', reasonType: 'missing_information' as const, question: '形式？', why: '决定交付', options: [] }] }] } }
  expect(() => parseProjectOwnerPlanningResponse({ ...response, change: { kind: 'clarification_answers', questionId: 'b'.repeat(64), answers: { a: '现有用户' } } }, withQuestion)).toThrow('完整')
  expect(parseProjectOwnerPlanningResponse({ ...response, change: { kind: 'clarification_answers', questionId: 'b'.repeat(64), answers: { a: '现有用户', b: '一页' } } }, withQuestion).kind).toBe('conversation_change')

  for (const change of [{ ...revised(), goal: { ...revised().goal, codeSourceAccess: 'workspace' } }, { ...revised(), grant: true }, { kind: 'clarification_answers', questionId: 'a'.repeat(64), answers: {} }, { kind: 'goal_revision', goal: { objective: context.goal.goal.objective, constraints: context.goal.goal.constraints, acceptanceCriteria: context.goal.goal.acceptanceCriteria } }]) expect(() => parseProjectOwnerPlanningResponse({ ...response, change }, current)).toThrow()
})

test('Given目标已含相同答复 WhenOwner再提问且用户同框确认 Then不造新目标版本但答复后仍自动续做', async () => {
  const f = fixture()
  goals.saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '形成产品定位建议', constraints: ['Owner澄清答复（主要服务谁？）：现有用户'] })
  const grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f))); finish(f, 'clarify')
    await until(() => getOwnerManagementConversation(f.project.id).questions.some(item => item.state === 'open'))
    const question = getOwnerManagementConversation(f.project.id).questions[0]!
    sendOwnerManagementMessage({ ...f.message('仍是现有用户，请继续'), expectedGoalRevision: 2 })
    const view = await changed(f, () => ({ kind: 'clarification_answers', questionId: question.id, answers: { audience: '现有用户' } }))
    const input = decision(view), saved = changes.decideOwnerConversationChange(input)
    expect(saved.goal?.revision).toBe(2)
    expect(changes.decideOwnerConversationChange(input)).toEqual(saved)
    await until(() => Boolean(active(f)))
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(3)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(3)
    finish(f, 'plan')
    await until(() => plans.getProjectOwnerPlanDraft(f.project.id)?.state === 'proposed')
    expect(goals.listProjectOwnerGoalHistory(f.project.id)).toHaveLength(2)
    expect(changes.getOwnerConversationChange(f.project.id, view.id).state).toBe('applied')
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})


test('Given同目标普通管理规划与已完成对话 When重启管理循环 Then非答复事件不绕过去重追加请求', async () => {
  const f = fixture()
  sendOwnerManagementMessage(f.message('先说明你收到的目标'))
  const grant = f.issue()
  let stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f)))
    const execution = finish(f, 'reply')
    await until(() => store.getAgentExecution(execution.id)?.status === 'completed')
    stop()
    const pending = store.getProjectDb().prepare("SELECT planning_task_id, request_id FROM project_owner_planning_links l WHERE project_id=? AND json_extract(payload, '$.conversationMessageId') IS NULL AND NOT EXISTS (SELECT 1 FROM agent_executions e WHERE e.entity_id=l.planning_task_id) LIMIT 1").get(f.project.id) as { planning_task_id: string; request_id: string }
    const event = store.getProjectDb().prepare('SELECT payload FROM project_owner_management_events WHERE project_id=? AND id=?').get(f.project.id, pending.request_id.slice('management:'.length)) as { payload: string }
    expect(JSON.parse(event.payload).kind).toBe('goal_saved')
    stop = startOwnerManagementLoop()
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    expect(store.listAgentExecutionsByEntity('task', pending.planning_task_id)).toHaveLength(0)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given对话请求冻结旧问题 When本次结果提出更新问题 Then原请求仍可验证且新对话只带当前问题', async () => {
  const f = fixture(), grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f))); finish(f, 'clarify')
    await until(() => getOwnerManagementConversation(f.project.id).questions.some(item => item.state === 'open'))
    const old = getOwnerManagementConversation(f.project.id).questions[0]!
    sendOwnerManagementMessage(f.message('请重新说明需要我决定的问题'))
    await until(() => Boolean(active(f)))
    const execution = active(f)!, snapshot = readOwnerPlanningSnapshot(execution.entityId)!
    expect(snapshot.context.conversation?.openQuestions?.[0]?.id).toBe(old.id)
    finish(f, 'clarify')
    await until(() => getOwnerManagementConversation(f.project.id).questions.length === 2)
    expect(resolveOwnerPlanningTask(execution.entityId, true)?.context).toEqual(snapshot.context)
    const current = getOwnerManagementConversation(f.project.id).questions.find(item => item.state === 'open')!
    expect(current.id).not.toBe(old.id)
    expect(getOwnerManagementConversation(f.project.id).questions.find(item => item.id === old.id)?.state).toBe('stale')
    setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
    const msg = sendOwnerManagementMessage(f.message('按当前问题继续'))
    const context = withOwnerConversationContext(plans.getProjectOwnerPlanningContext(f.project.id), msg.id)
    expect(context.conversation?.openQuestions?.map(item => item.id)).toEqual([current.id])
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})
