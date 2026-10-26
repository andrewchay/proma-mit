import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
const directory = mkdtempSync(join(tmpdir(), 'owner-conversation-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const goals = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { resolveOwnerPlanningSession, readOwnerPlanningSnapshot, resolveOwnerPlanningTask } = await import('./project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { startDelegatedOwnerPlanningTask } = await import('./controlled-project-task-service')
const delegation = await import('./project-owner-management-delegation')
const { getOwnerManagementConversation } = await import('./project-owner-management-questions')
const { appendOwnerManagementMessage, getOwnerManagementView, getOwnerManager, setOwnerManagerStatus } = await import('./project-owner-management-store')
const { preparePendingOwnerConversation, sendOwnerManagementMessage, withOwnerConversationContext } = await import('./project-owner-management-conversation')
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
const { setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')
const { parseProjectOwnerPlanningResponse } = await import('./project-owner-planning-protocol')
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
    const input = { ...subject, requestId: randomUUID(), maxRequests: 6, maxCostMicros: 3_000_000, expiresAt: Date.now() + 3600000 }
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
  const feedback = source.context.conversation?.deliveryFeedback
  const result = kind === 'clarify' ? { schemaVersion: 1, kind: 'needs_clarification', binding, reason: '受众会改变定位', questions: [{ key: 'audience', reasonType: 'missing_information', question: '主要服务谁？', why: '确定定位', options: ['新用户', '现有用户'] }] } : kind === 'reply' ? { schemaVersion: 1, kind: 'conversation_reply', binding, messageId: source.context.conversation!.throughMessageId, message: '目前仍在方案讨论阶段，尚无真实成果证据。' } : { schemaVersion: 1, kind: 'plan_proposal', binding, proposal: { summary: '按反馈收敛方案', assumptions: [], risks: [], steps: [{ key: 'brief', title: '定位建议', outcome: '一页建议', acceptanceCriteria: ['说明取舍'], dependencies: [], roleKey: source.context.sources.roles[0]!.key }], ...(feedback ? { deliveryFeedbackAssessment: { messageId: feedback.messageId, artifactHash: feedback.artifactHash, ...(feedback.stepKey ? { stepKey: feedback.stepKey } : {}), summary: '在方案中增加目标用户分析', changes: feedback.acceptanceCriteria.map(criterion => ({ criterion, disposition: 'addressed', proposedChange: '增加对应分析' })), authorizationImpact: 'within_confirmed_boundary', authorizationRationale: '在当前确认范围内建议；旧执行许可不沿用' } } : {}) } }
  callbacks.get(execution.sessionId!)!.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId!, finish_reason: 'stop', result: JSON.stringify(result), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
  return execution
}

test('Given自然语言消息 When保存、重复提交及数据库重开 Then同一会话只一条且不修改目标/计划或调用模型', async () => {
  const f = fixture(), input = f.message('希望先讨论取舍，不要立刻执行')
  const before = goals.getProjectOwnerGoalDraft(f.project.id)
  const saved = sendOwnerManagementMessage(input)
  expect(sendOwnerManagementMessage(input)).toEqual(saved)
  expect(goals.getProjectOwnerGoalDraft(f.project.id)).toEqual(before)
  expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
  expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
  store.closeProjectDb(); await store.initProjectDb()
  expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'conversation')).toEqual([saved])
  expect(() => sendOwnerManagementMessage({ ...input, content: '不同内容' })).toThrow('请求ID')
})

test('Given管理配置变化使委托失效 When用户继续发消息 Then先解释暂停且重新授权后自动处理原消息', async () => {
  const f = fixture(), previousGrant = f.issue()
  const binding = (await import('./project-owner-runtime-binding')).getOwnerRuntimeBinding(f.project.id)!
  saveOwnerRuntimeBinding(f.project.id, binding.revision, { ownerName: 'Owner', carrierId: binding.carrierId, workspaceId: binding.workspaceId, changeReason: '模拟授权后配置修订' })
  const saved = sendOwnerManagementMessage(f.message('请继续推进，并告诉我目前卡在哪里'))
  const stop = startOwnerManagementLoop()
  let renewedGrant: ReturnType<typeof delegation.confirmOwnerManagementDelegation> | undefined
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.eventId.startsWith(`conversation-blocked:${saved.id}:stale:`)))
    const blocked = getOwnerManagementConversation(f.project.id).messages.find(item => item.eventId.startsWith(`conversation-blocked:${saved.id}:stale:`))!
    expect(blocked).toMatchObject({ kind: 'attention', content: expect.stringContaining('管理授权已失效') })
    expect(getOwnerManagementView(f.project.id).trace).toContainEqual(expect.objectContaining({ projectId: f.project.id, phase: 'owner_response', state: 'blocked', detailCode: 'authorization_changed' }))
    expect(store.getProjectDb().prepare("SELECT COUNT(*) AS c FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload,'$.conversationMessageId')=?").get(f.project.id, saved.id)).toEqual({ c: 0 })
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)

    const input = { ...f.subject, requestId: randomUUID(), maxRequests: 6, maxCostMicros: 3_000_000, expiresAt: Date.now() + 3600000 }
    const preview = delegation.previewOwnerManagementDelegation(input)
    renewedGrant = delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
    await until(() => Boolean(active(f)))
    expect(readOwnerPlanningSnapshot(active(f)!.entityId)!.context.conversation?.throughMessageId).toBe(saved.id)
    finish(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'reply'))
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 1 })
  } finally {
    stop()
    if (renewedGrant) delegation.revokeOwnerManagementDelegation(f.project.id, renewedGrant.id)
    delegation.revokeOwnerManagementDelegation(f.project.id, previousGrant.id)
  }
})

test('Given旧版遗留同源对话Link且没有执行记录 When Owner后台恢复 Then从原Link启动一次并回应原消息', async () => {
  const f = fixture(), saved = sendOwnerManagementMessage(f.message('如何了？')), grant = f.issue()
  expect(preparePendingOwnerConversation(f.project.id)).toBe(true)
  const original = getOwnerManagementConversation(f.project.id).messages.find(item => item.eventId.startsWith(`conversation-ready:${saved.id}:`))!
  const planningTaskId = original.planningTaskId!
  expect(resolveOwnerPlanningTask(planningTaskId)!.link.conversationMessageId).toBe(saved.id)
  expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
  const stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f)))
    const execution = active(f)!
    expect(execution.entityId).toBe(planningTaskId)
    expect(readOwnerPlanningSnapshot(execution.entityId)!.context.conversation?.throughMessageId).toBe(saved.id)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    finish(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'reply'))
    reconcileOwnerManagement(f.project.id)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'reply')).toHaveLength(1)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given旧授权失效且旧版已有未执行对话Link When后台对账并重新授权 Then先说明暂停且只续接原消息一次', async () => {
  const f = fixture(), previousGrant = f.issue(), saved = sendOwnerManagementMessage(f.message('如何了？'))
  expect(preparePendingOwnerConversation(f.project.id)).toBe(true)
  expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.eventId.startsWith(`conversation-ready:${saved.id}:`))).toBe(true)
  expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)

  const binding = (await import('./project-owner-runtime-binding')).getOwnerRuntimeBinding(f.project.id)!
  saveOwnerRuntimeBinding(f.project.id, binding.revision, { ownerName: 'Owner', carrierId: binding.carrierId, workspaceId: binding.workspaceId, changeReason: '模拟旧版待处理消息期间配置修订' })
  const stop = startOwnerManagementLoop()
  let renewedGrant: ReturnType<typeof delegation.confirmOwnerManagementDelegation> | undefined
  try {
    await until(() => {
      const messages = getOwnerManagementConversation(f.project.id).messages
      return messages.some(item => item.eventId.startsWith(`management-delegation-stale:${previousGrant.id}`))
        && messages.some(item => item.eventId.startsWith(`conversation-blocked:${saved.id}:stale:`))
    })
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)

    renewedGrant = f.issue()
    await until(() => Boolean(active(f)))
    const execution = active(f)!
    expect(readOwnerPlanningSnapshot(execution.entityId)!.context.conversation?.throughMessageId).toBe(saved.id)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    finish(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'reply'))
    reconcileOwnerManagement(f.project.id)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'reply')).toHaveLength(1)
  } finally {
    stop()
    if (renewedGrant) delegation.revokeOwnerManagementDelegation(f.project.id, renewedGrant.id)
    delegation.revokeOwnerManagementDelegation(f.project.id, previousGrant.id)
  }
})

test('Given已验收交付与精确版本 When用户发送修改意见 Then主进程校验来源并冻结准确成果正文到Owner上下文', () => {
  const f = fixture(), content = '已验收的原始交付正文', artifactHash = createHash('sha256').update(content, 'utf8').digest('hex')
  const delivery = appendOwnerManagementMessage({ projectId: f.project.id, eventId: `delivery:${randomUUID()}`, role: 'assistant', kind: 'delivery', ...(f.taskId ? { taskId: f.taskId } : {}), content: 'Owner已验收成果', delivery: { schemaVersion: 1, planVersion: 1, items: [{ stepKey: 'brief', title: '产品建议', acceptanceCriteria: ['给出依据'], artifactHash, content, ownerDecision: '按标准接受', reviewerSummary: '独立检查通过' }, { stepKey: 'appendix', title: '补充建议', acceptanceCriteria: ['列出限制'], artifactHash, content, ownerDecision: '按标准接受', reviewerSummary: '独立检查通过' }] } })
  const reference = { messageId: delivery.id, artifactHash, stepKey: 'brief' }
  const input = { ...f.message('请按反馈调整这份建议'), deliveryReference: reference }
  const saved = sendOwnerManagementMessage(input)
  expect(saved.deliveryReference).toEqual(reference)
  const context = withOwnerConversationContext(plans.getProjectOwnerPlanningContext(f.project.id), saved.id)
  expect(context.conversation?.deliveryFeedback).toMatchObject({ messageId: delivery.id, artifactHash, stepKey: 'brief', title: '产品建议', content, acceptanceCriteria: ['给出依据'] })
  expect(() => sendOwnerManagementMessage({ ...f.message('未指明成果项'), deliveryReference: { messageId: delivery.id, artifactHash } })).toThrow('不唯一')
  expect(() => sendOwnerManagementMessage({ ...f.message('错误成果项'), deliveryReference: { ...reference, stepKey: 'missing' } })).toThrow('不唯一')
  expect(() => sendOwnerManagementMessage({ ...f.message('伪造成果来源'), deliveryReference: { ...reference, artifactHash: 'f'.repeat(64) } })).toThrow('成果版本')
  expect(() => sendOwnerManagementMessage({ ...f.message('伪造交付消息'), deliveryReference: { ...reference, messageId: 'e'.repeat(64) } })).toThrow('成果不存在')
})

test('Given旧目标或跨项目/任务消息 When发送 Then拒绝伪造许可且事务回滚不留消息', () => {
  const f = fixture(true), input = f.message('只讨论这项任务')
  const other = fixture()
  for (const bad of [{ ...input, projectId: other.project.id }, { ...input, taskId: randomUUID() }, { ...input, expectedGoalRevision: 99 }, { ...input, actor: 'admin' }, { ...input, grant: true }, { ...input, content: ' ' }]) expect(() => sendOwnerManagementMessage(bad)).toThrow()
  expect(() => store.getProjectDb().transaction(() => { sendOwnerManagementMessage(input); throw new Error('外层回滚') })()).toThrow('外层回滚')
  expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'conversation')).toHaveLength(0)
  const saved = sendOwnerManagementMessage(input)
  goals.saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '修改后目标' }, f.taskId)
  expect(sendOwnerManagementMessage(input)).toEqual(saved)
})

test('Given准确用户消息与已有确认方案 When构建对话快照 Then指纹不变、隔离主体且聊天不使计划过期', () => {
  const f = fixture(true), context = plans.getProjectOwnerPlanningContext(f.project.id, f.taskId)
  plans.saveProjectOwnerPlanDraft(f.project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '计划', assumptions: [], risks: [], steps: [{ key: 'a', title: '建议', outcome: '报告', acceptanceCriteria: ['可读'], dependencies: [], roleKey: context.sources.roles[0]!.key }], changeReason: '保存' }, f.taskId)
  plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 1, f.taskId)
  const first = sendOwnerManagementMessage(f.message('解释这个方案的取舍'))
  const frozen = withOwnerConversationContext(context, first.id)
  sendOwnerManagementMessage(f.message('后续补充'))
  const replay = withOwnerConversationContext(context, first.id, frozen.conversation!.historyThroughMessageId)
  expect(replay).toEqual(frozen)
  expect(frozen.fingerprint).toBe(context.fingerprint)
  expect(frozen.conversation!.messages.map(item => item.content)).not.toContain('后续补充')
  expect(plans.getProjectOwnerPlanDraft(f.project.id, f.taskId)?.state).toBe('confirmed')
  expect(() => withOwnerConversationContext(plans.getProjectOwnerPlanningContext(f.project.id), first.id)).toThrow()
})

test('Given有效持续对话委托 When离页后台回应并在途收到两条消息 Then串行合并后续消息且无重复调用', async () => {
  const f = fixture(), first = sendOwnerManagementMessage(f.message('目前做到哪里了？')), grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f)))
    const firstSource = readOwnerPlanningSnapshot(active(f)!.entityId)!
    expect(firstSource.link.conversationMessageId).toBe(first.id)
    sendOwnerManagementMessage(f.message('解释一下范围'))
    const last = sendOwnerManagementMessage(f.message('方案请先控制在一页'))
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'management_progress' && item.content.includes('正在完成当前回复')))
    const waiting = getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'management_progress' && item.content.includes('正在完成当前回复'))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.eventId).toBe(`conversation-waiting:${last.id}`)
    reconcileOwnerManagement(f.project.id); reconcileOwnerManagement(f.project.id)
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.eventId === `conversation-waiting:${last.id}`)).toHaveLength(1)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    finish(f)
    await until(() => Boolean(active(f)) && readOwnerPlanningSnapshot(active(f)!.entityId)!.link.conversationMessageId === last.id)
    const next = readOwnerPlanningSnapshot(active(f)!.entityId)!
    expect(next.context.conversation!.messages.some(item => item.content === '解释一下范围')).toBe(true)
    expect(next.context.conversation!.messages.some(item => item.content === '目前仍在方案讨论阶段，尚无真实成果证据。')).toBe(true)
    const responseTrace = getOwnerManagementView(f.project.id).trace?.find(entry => entry.phase === 'owner_response' && entry.taskId === f.taskId)
    expect(responseTrace?.state).toBe('started')
    expect(getOwnerManagementView(f.project.id).messages.some(item => item.content === '我正在处理你的补充或最新项目进展；完成后会在这里回应。')).toBe(true)
    finish(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'reply').length === 2)
    reconcileOwnerManagement(f.project.id)
    const messages = store.getProjectDb().prepare("SELECT json_extract(payload, '$.conversationMessageId') AS message_id FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload, '$.conversationMessageId') IS NOT NULL").all(f.project.id) as Array<{ message_id: string }>
    expect(messages.map(item => item.message_id).sort()).toEqual([first.id, last.id].sort())
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(2)
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 2 })
    expect(goals.getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(1)
    expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given用户在对话要求方案修改 WhenOwner生成提案 Then保存待审计划、不自动确认或发业务授权', async () => {
  const f = fixture(), content = '首次已验收的产品建议', artifactHash = createHash('sha256').update(content, 'utf8').digest('hex')
  const delivery = appendOwnerManagementMessage({ projectId: f.project.id, eventId: `delivery:${randomUUID()}`, role: 'assistant', kind: 'delivery', content: 'Owner已验收首次交付', delivery: { schemaVersion: 1, planVersion: 1, items: [{ stepKey: 'brief', title: '产品建议', acceptanceCriteria: ['说明依据'], artifactHash, content, ownerDecision: '按标准接受', reviewerSummary: '独立检查通过' }] } })
  const feedback = sendOwnerManagementMessage({ ...f.message('请依据这份建议增加目标用户分析'), deliveryReference: { messageId: delivery.id, artifactHash } })
  const grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f)))
    const planningContext = readOwnerPlanningSnapshot(active(f)!.entityId)!.context
    expect(planningContext.conversation?.throughMessageId).toBe(feedback.id)
    expect(planningContext.conversation?.deliveryFeedback).toMatchObject({ messageId: delivery.id, artifactHash, title: '产品建议', content, acceptanceCriteria: ['说明依据'] })
    finish(f, 'plan')
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'plan_proposal'))
    const plan = plans.getProjectOwnerPlanDraft(f.project.id)!
    expect(plan).toMatchObject({ state: 'proposed', origin: 'generated', proposal: { summary: '按反馈收敛方案' } })
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ c: 0 })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given管理暂停且有新消息 When重开再恢复 Then消息保留、恢复前零调用且恢复后自动回应', async () => {
  const f = fixture(), grant = f.issue(), manager = getOwnerManager(f.project.id)!
  setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
  const saved = sendOwnerManagementMessage(f.message('保留这个问题，恢复后讨论'))
  store.closeProjectDb(); await store.initProjectDb()
  const stop = startOwnerManagementLoop()
  try {
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.id === saved.id)).toBe(true)
    setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'active')
    await until(() => Boolean(active(f))); finish(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'reply'))
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given普通规划请求或不同消息ID When解析持续对话回应 Then不能伪装当前消息的结果', () => {
  const f = fixture(), context = plans.getProjectOwnerPlanningContext(f.project.id), message = sendOwnerManagementMessage(f.message('请解释'))
  const response = { schemaVersion: 1, kind: 'conversation_reply', binding: { projectId: f.project.id, goalVersion: 1, contextFingerprint: context.fingerprint }, messageId: message.id, message: '建议' }
  expect(() => parseProjectOwnerPlanningResponse(response, context)).toThrow('本次对话')
  const frozen = withOwnerConversationContext(context, message.id)
  expect(parseProjectOwnerPlanningResponse(response, frozen)).toMatchObject({ kind: 'conversation_reply', message: '建议' })
  expect(() => parseProjectOwnerPlanningResponse({ ...response, messageId: 'a'.repeat(64) }, frozen)).toThrow('本次对话')
})

test('Given历史管理委托未包含持续对话 When新消息到达及内部入口尝试启动 Then不扩大旧额度', async () => {
  const f = fixture(), grant = f.issue()
  const { getOwnerRuntimeBinding, getOwnerCarrierFacts } = await import('./project-owner-runtime-binding')
  const { getPilotReviewedPriceEvidenceForModel } = await import('./project-pilot-request-evidence')
  const { createHash } = await import('node:crypto')
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const binding = getOwnerRuntimeBinding(f.project.id)!, facts = getOwnerCarrierFacts(f.project.id, binding.carrierId, binding.workspaceId)
  // 只读兼容性的历史记录夹具；不通过此行伪造可发送的新权限。
  const legacy: Record<string, unknown> = { ...grant }; delete legacy.conversationEnabled; delete legacy.executionFollowupEnabled; delete legacy.fullDeliveryReviewEnabled; delete legacy.qualityDecisionEnabled
  legacy.scopeHash = digest({ ownerId: getOwnerManager(f.project.id)!.ownerId, binding, configurationFingerprint: facts.carrierConfigurationFingerprint, sources: plans.getProjectOwnerPlanningContext(f.project.id).sources, price: getPilotReviewedPriceEvidenceForModel(binding.modelId, 'openai') })
  const { previewHash: _hash, id: _id, issuedAt: _at, ...body } = legacy
  legacy.previewHash = digest(body)
  store.getProjectDb().prepare('UPDATE project_owner_management_delegations SET payload=?,integrity_hash=? WHERE id=?').run(JSON.stringify(legacy), digest(legacy), grant.id)
  expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('active')
  sendOwnerManagementMessage(f.message('请回应这个问题'))
  const stop = startOwnerManagementLoop()
  try {
    const taskId = getOwnerManagementConversation(f.project.id).messages.findLast(item => item.planningTaskId)?.planningTaskId!
    expect(resolveOwnerPlanningTask(taskId)!.link.conversationMessageId).toBeTruthy()
    await expect(startDelegatedOwnerPlanningTask(taskId)).rejects.toThrow('旧管理委托')
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(0)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given回应缺可信用量 When新消息到达 Then保留新消息但停等核对、不自动补发模型', async () => {
  const f = fixture(); sendOwnerManagementMessage(f.message('先解释现状'))
  const grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f)))
    const execution = active(f)!, source = resolveOwnerPlanningSession(execution.sessionId!)!
    const response = { schemaVersion: 1, kind: 'conversation_reply', binding: { projectId: f.project.id, goalVersion: 1, contextFingerprint: source.context.fingerprint }, messageId: source.link.conversationMessageId, message: '建议等待更多资料。' }
    callbacks.get(execution.sessionId!)!.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId!, finish_reason: 'stop', result: JSON.stringify(response), usage: { input_tokens: 10, output_tokens: 20 } } })
    await until(() => delegation.getOwnerManagementDelegation(f.project.id).state === 'attention')
    const saved = sendOwnerManagementMessage(f.message('还需要哪些资料？'))
    reconcileOwnerManagement(f.project.id)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.id === saved.id)).toBe(true)
    const attention = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'attention' && item.content.includes('暂停了后续处理'))
    expect(attention?.content).toContain('重新确认授权范围不会解除这次暂停')
    expect(attention?.content).toContain('不能登记外部账单核对结果')
    expect(attention?.content).not.toContain('确认后我会自动继续处理这条消息')
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(1)
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'attention', usedRequests: 1 })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given暂停期间消息后目标已修改 When恢复对账 Then明确提示旧消息未套用新目标且不重复提醒', () => {
  const f = fixture(), manager = getOwnerManager(f.project.id)!
  setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
  sendOwnerManagementMessage(f.message('这个旧目标应保留一页'))
  goals.saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '新的目标' })
  setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'active')
  reconcileOwnerManagement(f.project.id); reconcileOwnerManagement(f.project.id)
  expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.content.includes('不会把它套用到新目标'))).toHaveLength(1)
  expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
})

test('GivenOwner对话IPC When普通消息或夹带身份权限 Then只接受真实用户消息且不签发业务授权', async () => {
  const f = fixture(), input = f.message('请说明接下来要做什么')
  const { registerProjectOwnerGoalIpcHandlers } = await import('./project-owner-goal-ipc')
  const { PROJECT_IPC_CHANNELS } = await import('@gravitas/shared')
  const handlers = new Map<string, (event: unknown, request: unknown) => unknown>()
  registerProjectOwnerGoalIpcHandlers({ handle: (name, handler) => { handlers.set(name, handler) } })
  const invoke = (raw: unknown) => handlers.get(PROJECT_IPC_CHANNELS.SEND_OWNER_MANAGEMENT_MESSAGE)!(undefined, raw)
  expect(invoke(input)).toMatchObject({ ok: true, value: { content: input.content, kind: 'conversation', role: 'user' } })
  for (const raw of [null, [], { ...input, actor: 'Owner' }, { ...input, grantId: 'fake' }, { ...input, role: 'assistant' }]) expect(invoke(raw)).toMatchObject({ ok: false })
  expect(store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ c: 0 })
})


test('Given对话内仍开放的旧澄清 When随后对话生成新方案 Then旧答复不能应用到新方案', async () => {
  const f = fixture(); sendOwnerManagementMessage(f.message('先确认定位的必要信息'))
  const grant = f.issue(), stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(active(f))); finish(f, 'clarify')
    await until(() => getOwnerManagementConversation(f.project.id).questions.some(item => item.state === 'open'))
    const question = getOwnerManagementConversation(f.project.id).questions[0]!
    sendOwnerManagementMessage(f.message('请先按当前资料提出可讨论的方案'))
    await until(() => Boolean(active(f)))
    expect(getOwnerManagementConversation(f.project.id).questions[0]!.state).toBe('open')
    finish(f, 'plan')
    await until(() => Boolean(plans.getProjectOwnerPlanDraft(f.project.id)))
    expect(getOwnerManagementConversation(f.project.id).questions[0]!.state).toBe('stale')
    const { answerOwnerManagementQuestion } = await import('./project-owner-management-questions')
    expect(() => answerOwnerManagementQuestion({ projectId: f.project.id, questionId: question.id, requestId: randomUUID(), expectedGoalRevision: question.goalRevision, expectedContextFingerprint: question.contextFingerprint, answers: { audience: '现有用户' } })).toThrow()
    expect(goals.getProjectOwnerGoalDraft(f.project.id)?.revision).toBe(1)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})
