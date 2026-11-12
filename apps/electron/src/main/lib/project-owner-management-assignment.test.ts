import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
import type { OwnerExecutionPreparationInput, ProjectOwnerExecutionLaunchApi } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-managed-assignment-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const { getOwnerRuntimeBinding, saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { ensureOwnerDefaultTeam } = await import('./project-owner-default-team')
const { resolveOwnerPlanningSession } = await import('./project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { getOwnerManagementConversation } = await import('./project-owner-management-questions')
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
const { appendOwnerManagementTrace, consumeOwnerManagementEvent, getOwnerManager, getOwnerManagementView, listPendingOwnerManagementEvents, setOwnerManagerStatus } = await import('./project-owner-management-store')
const { onOwnerManagementChanged } = await import('./project-owner-management-events')
const delegation = await import('./project-owner-management-delegation')
const ipcHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
const { setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')
const { listOwnerExecutionAssignmentRuns } = await import('./project-owner-execution-assignment-service')
const teamAccess = await import('./project-owner-team-workspace-access')
const { retakeOwnerManagementAssignment } = await import('./project-owner-manual-retake')
const calls: Array<{ projectId: string; purpose: string; candidates: string[]; executionKinds?: string[]; employeeModes?: Array<{ id: string; executionProfile: string; ownerControlledCompatible?: boolean }> }> = []
let rejectNextAssignmentProjectId: string | null = null
let legacyNullScopeProjectId: string | null = null
let rejectNextAssignmentKind: 'reviewer' | 'coverage' = 'reviewer'
let nextOwnerPlanningResponseGate: { started(): void; wait: Promise<void> } | null = null
let failBusinessProjectId: string | null = null
let reviseConversationProjectId: string | null = null
let mixedRecoveryProjectId: string | null = null
let legacyUntypedRecoveryProjectId: string | null = null
beforeAll(async () => {
  await store.initProjectDb()
  // 排队、来源与最终单发送准入使用产品实现；runner/HTTP和模型回答是隔离替身。
  setHeadlessAgentRunner(async (input, handlers) => {
    const execution = store.getAgentExecutionBySessionId(input.sessionId)
    if (execution?.ownerCommandId) {
      handlers.onRuntimeStarted?.()
      const command = store.getProjectDb().prepare('SELECT role FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { role: string }
      const task = store.getTask(execution.entityId)!
      const workspaceManager = await import('./agent-workspace-manager')
      const workspace = workspaceManager.getAgentWorkspace(task.workspaceId!)!
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const boundary = await import('./controlled-provider-boundary')
      const fetch = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: workspaceManager.getAgentWorkspaceCwd(workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      await fetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      if (failBusinessProjectId === execution.projectId) {
        failBusinessProjectId = null
        handlers.onError('模拟员工执行失败')
        return
      }
      let content = '已整理目标范围、证据和取舍，并标明仍需业务核验的不确定项。'
      const frozen = (await import('./project-owner-employee-runtime')).readOwnerCommandFrozenSource(execution.ownerCommandId)
      const development = (await import('./project-owner-employee-runtime')).ownerTaskDeliveryKind(frozen.source, frozen.taskId) === 'development'
      if (mixedRecoveryProjectId === execution.projectId && development && command.role === 'executor') {
        const { bindTestToolContext } = await import('./testing/bound-tool-context')
        const { executeWriteTool } = await import('./agent-runtime/tool-impls/write-tool')
        const cwd = workspaceManager.getAgentWorkspaceCwd(workspace, input.sessionId)
        const result = await executeWriteTool({ file_path: 'diary/index.html', content: '<!doctype html><html><body>五年日记</body></html>' }, bindTestToolContext({ cwd, sessionId: input.sessionId, ownerWorkspaceWrite: true }))
        if (result.isError) throw new Error(result.content)
        expect(frozen.source.autonomousWorkspaceEditVersion).toBe(1)
        const gates = await import('./project-owner-execution-gates')
        const args = { file_path: 'diary/index.html', content: '内容' }
        expect(gates.isOwnerAutoAllowedWorkspaceWrite(input.sessionId, 'Write', args)).toBe(true)
        expect(() => gates.assertOwnerCanonicalWorkspacePath(input.sessionId, join(cwd, 'other/index.html'))).toThrow('真实路径不在已确认范围内')
        renameSync(join(cwd, 'diary'), join(cwd, 'other'))
        symlinkSync('other', join(cwd, 'diary'))
        try {
          expect(gates.isOwnerAutoAllowedWorkspaceWrite(input.sessionId, 'Write', args)).toBe(false)
          const redirected = await executeWriteTool({ file_path: 'diary/index.html', content: '越界覆盖' }, bindTestToolContext({ cwd, sessionId: input.sessionId, ownerWorkspaceWrite: true }))
          expect(redirected.isError).toBe(true)
          expect(readFileSync(join(cwd, 'other/index.html'), 'utf8')).toContain('五年日记')
        } finally { unlinkSync(join(cwd, 'diary')); renameSync(join(cwd, 'other'), join(cwd, 'diary')) }
        linkSync(join(cwd, 'diary/index.html'), join(cwd, 'diary/link.html'))
        expect(gates.isOwnerAutoAllowedWorkspaceWrite(input.sessionId, 'Write', args)).toBe(false)
        unlinkSync(join(cwd, 'diary/link.html'))
        const db = store.getProjectDb()
        const grant = db.prepare('SELECT grant_id FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { grant_id: string }
        db.prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=?").run(grant.grant_id)
        try {
          expect(gates.isOwnerAutoAllowedWorkspaceWrite(input.sessionId, 'Write', args)).toBe(false)
          expect(gates.isOwnerAutoAllowedExistingWorkspaceWrite(input.sessionId, args)).toBe(false)
        } finally { db.prepare("UPDATE project_owner_execution_grants SET state='active' WHERE id=?").run(grant.grant_id) }
        const delegation = db.prepare('SELECT owner_management_delegation_id FROM project_owner_execution_grants WHERE id=?').get(grant.grant_id) as { owner_management_delegation_id: string }
        db.prepare('UPDATE project_owner_management_delegations SET revoked_at=? WHERE id=?').run(Date.now(), delegation.owner_management_delegation_id)
        try { expect(gates.isOwnerAutoAllowedExistingWorkspaceWrite(input.sessionId, args)).toBe(false) }
        finally { db.prepare('UPDATE project_owner_management_delegations SET revoked_at=NULL WHERE id=?').run(delegation.owner_management_delegation_id) }
        const edited = await (await import('./agent-runtime/tool-impls/edit-tool')).executeEditTool({ file_path: 'diary/index.html', old_string: '五年日记', new_string: '五年日记本' }, bindTestToolContext({ cwd, sessionId: input.sessionId, ownerWorkspaceWrite: true }))
        if (edited.isError) throw new Error(edited.content)
        const rewritten = await executeWriteTool({ file_path: 'diary/index.html', content: '<!doctype html><html><body>五年日记本</body></html>' }, bindTestToolContext({ cwd, sessionId: input.sessionId, ownerWorkspaceWrite: true }))
        if (rewritten.isError) throw new Error(rewritten.content)
        const denied = await executeWriteTool({ file_path: 'diary/outside.html', content: '越界' }, bindTestToolContext({ cwd, sessionId: input.sessionId, ownerWorkspaceWrite: true }))
        expect(denied.isError).toBe(true)
      }
      if (command.role === 'reviewer') {
        if (mixedRecoveryProjectId === execution.projectId && development) {
          const artifact = (await import('./project-owner-development-artifact')).ownerDevelopmentArtifactFromPrompt(input.userMessage)!
          content = JSON.stringify({ schemaVersion: 3, artifactHash: artifact.contentHash, verdict: 'approved', summary: '页面与验证符合目标', criteria: [{ criterion: '页面可打开', status: 'met', evidence: '快照包含页面，浏览器验证通过', quote: '五年日记' }], findings: [], blockerReason: null })
        } else {
        const textDelivery = await import('./project-owner-text-delivery')
        const artifact = textDelivery.assertOwnerReviewerTextDelivery(execution.ownerCommandId)!
        const link = store.getProjectDb().prepare('SELECT payload FROM project_owner_task_step_links WHERE task_id=?').get(execution.entityId) as { payload: string }
        const acceptance = (JSON.parse(link.payload) as { projection: { acceptanceCriteria: string[] } }).projection.acceptanceCriteria[0]!
        content = JSON.stringify({ schemaVersion: 2, artifactHash: artifact.contentSha256, verdict: 'approved', summary: '完整成果符合当前范围', criteria: [{ criterion: acceptance, status: 'met', evidence: '完整文本成果含有可核对依据', quote: artifact.content }], findings: [], blockerReason: null })
        }
      }
      const message = { id: randomUUID(), role: 'assistant' as const, content, createdAt: Date.now() }
      ;(await import('./agent-session-manager')).appendAgentMessage(input.sessionId, message)
      handlers.onComplete([message])
      return
    }
    const source = resolveOwnerPlanningSession(input.sessionId)!
    const conversation = source.context.conversation
    const delivery = conversation?.deliveryReview
    const observation = conversation?.executionObservation
    const claimProviderRequest = () => claimOwnerPlanningProviderRequest(
      input.sessionId,
      JSON.stringify({
        model: source.binding.modelId,
        stream: true,
        max_tokens: source.link.maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: source.request.systemPrompt },
          { role: 'user', content: source.request.userPrompt },
        ],
      }),
      new URL('https://example.invalid/v1/chat/completions'),
    )
    if (delivery?.qualityDecisionVersion === 1 && (delivery.artifact || delivery.developmentArtifact) && observation) {
      calls.push({ projectId: source.link.projectId, purpose: 'owner_quality', candidates: [] })
      claimProviderRequest()
      const binding = { projectId: source.link.projectId, ...(source.context.goal.goal.taskId ? { taskId: source.context.goal.goal.taskId } : {}), goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }
      const decision = { reviewerCommandId: observation.commandId, artifactHash: delivery.artifact?.contentSha256 ?? delivery.developmentArtifact!.contentHash, verdict: 'accept', reason: '已按完整成果、验收标准与独立评审核对', criteria: delivery.review!.criteria.map(item => ({ criterion: item.criterion, status: 'met', evidence: '成果与独立评审均包含对应依据', quote: delivery.artifact?.content ?? '五年日记' })), findings: [] }
      const response = { schemaVersion: 1, kind: 'quality_decision', ...binding, messageId: conversation.throughMessageId, message: '成果与独立检查已完成核对，正在记录验收结果。', decision }
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(response), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
      return
    }
    if (observation && conversation) {
      calls.push({ projectId: source.link.projectId, purpose: 'owner_followup', candidates: [] })
      claimProviderRequest()
      const response = { schemaVersion: 1, kind: 'conversation_reply', projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint, messageId: conversation.throughMessageId, message: '我已记录当前进度，等独立检查完成后再核对成果。' }
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(response), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
      return
    }
    if (source.link.purpose === 'owner_planning') {
      calls.push({ projectId: source.link.projectId, purpose: source.link.purpose, candidates: [] })
      const roleKey = source.context.sources.roles.find(role => role.key === 'requirements-analyst')?.key ?? source.context.sources.roles[0]!.key
      const recoveringMixed = conversation && mixedRecoveryProjectId === source.link.projectId
      const legacyUntyped = recoveringMixed && legacyUntypedRecoveryProjectId === source.link.projectId && !source.link.requestId.startsWith('historical-conflict-replan:')
      const proposal = { schemaVersion: 1, kind: 'plan_proposal', binding: { projectId: source.link.projectId, goalVersion: source.context.goal.goal.goalVersion, contextFingerprint: source.context.fingerprint }, proposal: { summary: conversation && reviseConversationProjectId === source.link.projectId ? '继续完成定位简报' : '按目标形成定位简报', assumptions: [], risks: [], steps: [{ key: 'brief', title: '分析需求', outcome: '定位简报', acceptanceCriteria: ['证据和取舍明确'], dependencies: [], roleKey, ...(conversation && reviseConversationProjectId === source.link.projectId && !legacyUntyped ? { deliveryKind: 'text' as const } : {}) }, ...(recoveringMixed ? [{ key: 'build', title: '实现页面', outcome: '日记页面', acceptanceCriteria: ['页面可打开'], dependencies: ['brief'], roleKey, ...(!legacyUntyped ? { deliveryKind: 'development' as const } : {}) }] : [])] } }
      claimProviderRequest()
      const gate = nextOwnerPlanningResponseGate
      if (gate) {
        nextOwnerPlanningResponseGate = null
        gate.started()
        await gate.wait
      }
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify(proposal), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
      return
    }
    const context = source.assignmentContext
    if (!context) throw new Error('本用例只允许Owner规划或安排用途，不能启动员工')
    calls.push({ projectId: source.link.projectId, purpose: source.link.purpose, candidates: context.candidates.map(item => item.id), executionKinds: [...context.executionKinds], employeeModes: context.candidates.map(({ id, executionProfile, ownerControlledCompatible }) => ({ id, executionProfile, ...(ownerControlledCompatible ? { ownerControlledCompatible } : {}) })) })
    claimProviderRequest()
    const reviewer = context.candidates.find(item => item.roleTemplateId === 'delivery-verifier' || item.name === '独立检查')!
    const assignments = [...new Set(context.steps.map(step => step.roleKey))].map(roleKey => ({ roleKey, employeeId: context.candidates.find(item => item.roleTemplateId === roleKey || item.name === '分析师')!.id, reason: '岗位能力适用' }))
    const selectedIds = [...assignments.map(item => item.employeeId), reviewer.id]
    const workspaceId = context.workspaces.find(workspace => selectedIds.every(id => context.candidates.find(candidate => candidate.id === id)?.workspaceIds.includes(workspace.id)))?.id
    if (!workspaceId) throw new Error('fake安排没有共同的已授权员工工作区')
    const rejectedReviewer = rejectNextAssignmentProjectId === source.link.projectId ? assignments[0]?.employeeId : undefined
    if (rejectedReviewer) rejectNextAssignmentProjectId = null
    const development = context.steps.some(step => step.deliveryKind === 'development') || (legacyUntypedRecoveryProjectId === source.link.projectId && context.steps.length > 1 && context.steps.every(step => !step.deliveryKind))
    const proposal = { schemaVersion: 1, contextFingerprint: context.contextFingerprint, selectedStepKeys: context.steps.map(step => step.key), scopeReason: '执行已确认的完整方案', workspaceId, workspaceReason: '复用项目已有授权', executionKind: development ? 'development' : 'controlled', executionKindReason: development ? '需要实现页面' : '无需代码修改', assignments: rejectedReviewer && rejectNextAssignmentKind === 'coverage' ? [] : assignments, reviewerEmployeeId: rejectNextAssignmentKind === 'reviewer' ? rejectedReviewer ?? reviewer.id : reviewer.id, reviewerReason: '独立检查成果', ...(development ? { developmentScope: { targetPaths: ['diary/index.html'], allowedPaths: ['diary/index.html'], verificationCommands: ['browser:html.loads'], reason: '交付日记页面' } } : {}) }
    const isLegacyNullScope = legacyNullScopeProjectId === source.link.projectId
    const rejected = isLegacyNullScope ? spyOn(await import('./project-owner-execution-assignment-protocol'), 'parseOwnerExecutionAssignmentProposal').mockImplementationOnce(() => { throw new Error('受控非研发安排不得包含代码范围') }) : null
    if (isLegacyNullScope) legacyNullScopeProjectId = null
    try {
      handlers.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: input.sessionId, finish_reason: 'stop', result: JSON.stringify({ ...proposal, ...(isLegacyNullScope ? { developmentScope: null } : {}) }), usage: { input_tokens: 10, output_tokens: 20 }, owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null } } })
    } finally { rejected?.mockRestore() }
  })
})
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(team: 'complete' | 'missing-reviewer' | 'missing-role' | 'general' | 'mixed' | 'development' | 'pi-team' | 'pi-development-team' = 'complete', taskScoped = false, savePlan = true, saveGoal = true, separateTeamWorkspace = false) {
  const repo = team === 'development' ? mkdtempSync(join(tmpdir(), 'owner-recovery-git-')) : undefined
  if (repo) {
    execFileSync('git', ['init', '-q', repo])
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'baseline'])
  }
  const project = store.createProject({ title: '自动组织团队', description: '' }), workspace = createAgentWorkspace(`自动安排-${randomUUID()}`, repo ?? (team === 'pi-development-team' && !separateTeamWorkspace ? directory : undefined))
  const teamWorkspace = separateTeamWorkspace ? createAgentWorkspace(`共享团队-${randomUUID()}`, team === 'pi-development-team' ? directory : undefined) : workspace
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const executorChannel = ['mixed', 'pi-team', 'pi-development-team'].includes(team) ? createChannel({ name: 'fake executor', provider: team === 'pi-team' || team === 'pi-development-team' ? 'zhipu' : 'openai', baseUrl: team === 'pi-team' || team === 'pi-development-team' ? 'https://open.bigmodel.cn/api/paas/v4' : 'https://executor.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: 'glm', enabled: true }] }) : channel
  const employee = (name: string, roleTemplateId?: string) => {
    const teamEmployee = name !== 'Owner' && (team === 'pi-team' || team === 'pi-development-team' || name === '分析师' && team === 'mixed')
    const executionProfile = ['general', 'mixed'].includes(team) && name !== 'Owner' ? 'general' : ['development', 'pi-development-team'].includes(team) && name !== 'Owner' ? 'development' : 'controlled'
    return employees.createAgentEmployee({ name, role: name, ...(roleTemplateId ? { roleTemplateId } : {}), description: '', executionProfile, permissionMode: 'safe', runtime: teamEmployee && ['pi-team', 'pi-development-team'].includes(team) ? 'pi' : 'ai-sdk', channelId: teamEmployee ? executorChannel.id : channel.id, modelId: teamEmployee ? 'glm-5.3-flash' : 'deepseek-flash', workspaceIds: [(separateTeamWorkspace && name !== 'Owner' ? teamWorkspace : workspace).id] })
  }
  const owner = employee('Owner'), executor = employee('分析师', ['general', 'mixed'].includes(team) ? undefined : team === 'missing-role' ? 'visual-designer' : 'requirements-analyst'), reviewer = team === 'missing-reviewer' ? null : employee('独立检查', ['general', 'mixed'].includes(team) ? undefined : 'delivery-verifier')
  const taskId = taskScoped ? store.createTask(project.id, { title: '用户任务', description: '' }).id : undefined
  const subject = { projectId: project.id, ...(taskId ? { taskId } : {}) }
  if (saveGoal) saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成定位建议' }, taskId)
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  const context = saveGoal ? plans.getProjectOwnerPlanningContext(project.id, taskId) : null
  const plan = savePlan && context ? plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '定位研究', assumptions: [], risks: [], steps: [{ key: 'brief', title: '分析需求', outcome: '定位简报', acceptanceCriteria: ['证据和取舍明确'], dependencies: [], roleKey: 'requirements-analyst' }], changeReason: '创建可审核方案' }, taskId) : null
  return { project, workspace, teamWorkspace, owner, executor, reviewer, taskId, subject, plan, repo }
}
function confirm(f: ReturnType<typeof fixture>) { return plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 1, f.taskId) }
function authorize(f: ReturnType<typeof fixture>, autonomousExecution = false, maxRequests = 3, maxCostMicros = 10_000_000) {
  const input = { ...f.subject, requestId: randomUUID(), maxRequests, maxCostMicros, expiresAt: Date.now() + 3600000, ...(autonomousExecution ? { autonomousExecution: true as const, autonomousWorkspaceEditVersion: 1 as const } : {}) }
  const preview = delegation.previewOwnerManagementDelegation(input)
  return delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
}

test('Given旧目标已有执行批次 When用户修订目标并确认新自主额度 Then新Owner方案追加批次且旧批次暂停保留', async () => {
  const f = fixture('complete', false, false), first = authorize(f, true, 6)
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const { onOwnerAutonomousScheduleWake } = await import('./project-owner-autonomous-scheduler-events')
  const stopSchedule = onOwnerAutonomousScheduleWake(id => { if (id === f.project.id) void scheduler.runOwnerAutonomousSchedule(id) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery'))
    const before = store.getProjectDb().prepare('SELECT id,state FROM project_owner_execution_grants WHERE project_id=? ORDER BY rowid').all(f.project.id) as Array<{ id: string; state: string }>
    saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '收敛为一份新的定位建议', constraints: ['只保留一个实现交付步骤，独立Reviewer由系统负责'] })
    const next = authorize(f, true, 6)
    expect(next.maxCostMicros).toBe(first.maxCostMicros)
    await until(() => (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { count: number }).count > before.length)
    const after = store.getProjectDb().prepare('SELECT id,state FROM project_owner_execution_grants WHERE project_id=? ORDER BY rowid').all(f.project.id) as Array<{ id: string; state: string }>
    expect(after.find(item => item.id === before[0]!.id)?.state).toBe('paused')
    expect(after.at(-1)?.id).not.toBe(before[0]!.id)
    expect(store.listTasks(f.project.id).filter(item => item.ownerStepLinkId).length).toBeGreaterThan(1)
    await until(() => getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'delivery').length === 2)
  } finally { stop(); stopSchedule() }
}, 15000)

test('Given 旧批次执行失败且费用已结算 When 用户对话要求继续 Then 按新方案接续并保留旧账本', async () => {
  const f = fixture('complete', false, false)
  failBusinessProjectId = f.project.id
  reviseConversationProjectId = f.project.id
  authorize(f, true, 6, 20_000_000)
  const stop = startOwnerManagementLoop()
  try {
    const db = store.getProjectDb()
    await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id WHERE c.project_id=? AND c.state='settled' AND e.status='failed'").get(f.project.id)))
    const original = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { id: string }
    const grantService = await import('./project-owner-execution-grant-issue')
    const preview = grantService.previewOwnerExecutionGrantRevoke(f.subject, { grantId: original.id })
    expect(preview.blockers).toEqual([])
    grantService.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: original.id, confirmedFingerprint: preview.fingerprint })
    const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
    sendOwnerManagementMessage({ ...f.subject, conversationId: getOwnerManager(f.project.id)!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '继续完成' })
    await until(() => (db.prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { n: number }).n === 2,
      () => ({ delegation: delegation.getOwnerManagementDelegation(f.project.id), messages: getOwnerManagementConversation(f.project.id).messages.slice(-5) }))
    expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(original.id)).toEqual({ state: 'paused' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_owner_task_materializations WHERE project_id=?').get(f.project.id)).toEqual({ n: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_owner_execution_commands WHERE grant_id=?').get(original.id)).toEqual({ n: 1 })
    const revised = plans.getProjectOwnerPlanDraft(f.project.id)!
    expect(revised.proposal.steps[0]!.deliveryKind).toBe('text')
    expect(revised.planVersion).toBeGreaterThan(1)
  } finally {
    failBusinessProjectId = null
    reviseConversationProjectId = null
    await stop()
  }
}, 20000)

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('Given已说继续但旧方案未分类且启动冲突 When旧账本已结算 Then无需重复指令即可重新规划并交付代码', async () => {
  const native = resolve(import.meta.dir, '../../../resources/owner-safe-directory/owner_safe_directory.node')
  if (!existsSync(native)) execFileSync('bun', ['run', 'build:owner-safe-directory'], { cwd: resolve(import.meta.dir, '../../..') })
  const f = fixture('development', false, false)
  failBusinessProjectId = f.project.id
  reviseConversationProjectId = f.project.id
  authorize(f, true, 20, 20_000_000)
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const { onOwnerAutonomousScheduleWake } = await import('./project-owner-autonomous-scheduler-events')
  const browser = await import('./owner-runtime-browser-verifier')
  browser.setOwnerRuntimeBrowserRunner(async input => {
    expect(readFileSync(input.filePath, 'utf8')).toContain('五年日记')
    return { checks: input.templates.map(template => ({ id: template.id, title: template.title, status: 'passed' as const, detail: '隔离测试替身：源码存在' })), durationMs: 1, timedOut: false, relativePath: input.filePath }
  })
  const stopSchedule = onOwnerAutonomousScheduleWake(id => { if (id === f.project.id) void scheduler.runOwnerAutonomousSchedule(id) })
  const stop = startOwnerManagementLoop()
  try {
    const db = store.getProjectDb()
    await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id WHERE c.project_id=? AND c.state='settled' AND e.status='failed'").get(f.project.id)))
    const original = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { id: string }
    const grantService = await import('./project-owner-execution-grant-issue')
    const preview = grantService.previewOwnerExecutionGrantRevoke(f.subject, { grantId: original.id })
    grantService.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: original.id, confirmedFingerprint: preview.fingerprint })
    mixedRecoveryProjectId = f.project.id
    legacyUntypedRecoveryProjectId = f.project.id
    const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
    sendOwnerManagementMessage({ ...f.subject, conversationId: getOwnerManager(f.project.id)!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '继续完成' })
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'delivery' && message.delivery?.items.some(item => item.stepKey === 'build')), () => ({ messages: getOwnerManagementConversation(f.project.id).messages.slice(-5), executions: store.listAgentExecutionsByProject(f.project.id).filter(item => item.status === 'failed').map(item => item.error) }), 3000)
    const delivery = getOwnerManagementConversation(f.project.id).messages.find(message => message.kind === 'delivery' && message.delivery?.items.some(item => item.stepKey === 'build'))!
    expect(delivery.delivery!.items.find(item => item.stepKey === 'build')!.content).toContain('diary/index.html')
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_owner_planning_links WHERE project_id=? AND request_id LIKE 'historical-conflict-replan:%'").get(f.project.id)).toEqual({ n: 1 })
    expect(getOwnerManagementConversation(f.project.id).messages.filter(message => message.role === 'user' && message.content === '继续完成')).toHaveLength(1)
    expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(original.id)).toEqual({ state: 'paused' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_owner_execution_commands WHERE grant_id=?').get(original.id)).toEqual({ n: 1 })
  } finally {
    failBusinessProjectId = null; reviseConversationProjectId = null; mixedRecoveryProjectId = null; legacyUntypedRecoveryProjectId = null
    await stop()
    stopSchedule()
    browser.setOwnerRuntimeBrowserRunner(null)
    if (f.repo) rmSync(f.repo, { recursive: true, force: true })
  }
}, 45000)

test('Given 旧批次费用未知或已成功 When 对话要求继续 Then 保留证据且不重复派工', async () => {
  for (const scenario of ['unknown', 'unsettled', 'completed'] as const) {
    const f = fixture('development', false, false)
    failBusinessProjectId = f.project.id
    reviseConversationProjectId = f.project.id
    authorize(f, true, 6, 20_000_000)
    const stop = startOwnerManagementLoop()
    try {
      const db = store.getProjectDb()
      await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id WHERE c.project_id=? AND c.state='settled' AND e.status='failed'").get(f.project.id)))
      const original = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { id: string }
      const grantService = await import('./project-owner-execution-grant-issue')
      const preview = grantService.previewOwnerExecutionGrantRevoke(f.subject, { grantId: original.id })
      grantService.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: original.id, confirmedFingerprint: preview.fingerprint })
      if (scenario === 'unknown') db.prepare('UPDATE project_owner_execution_commands SET usage_evidence=NULL WHERE grant_id=?').run(original.id)
      if (scenario === 'unsettled') db.prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE command_id IN (SELECT id FROM project_owner_execution_commands WHERE grant_id=?)").run(original.id)
      if (scenario === 'completed') db.prepare("UPDATE agent_executions SET status='completed' WHERE owner_command_id IN (SELECT id FROM project_owner_execution_commands WHERE grant_id=?)").run(original.id)
      mixedRecoveryProjectId = f.project.id
      legacyUntypedRecoveryProjectId = f.project.id
      const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
      sendOwnerManagementMessage({ ...f.subject, conversationId: getOwnerManager(f.project.id)!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '继续完成' })
      await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_start_intents WHERE project_id=? AND recovery_status='needs_attention'").get(f.project.id)), () => ({ scenario, messages: getOwnerManagementConversation(f.project.id).messages.slice(-3) }))
      const recovery = await import('./project-owner-execution-start-intent')
      recovery.prepareHistoricalConflictedReplan(f.project.id)
      expect(db.prepare("SELECT COUNT(*) AS n FROM project_owner_planning_links WHERE project_id=? AND request_id LIKE 'historical-conflict-replan:%'").get(f.project.id)).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 1 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM project_owner_task_materializations WHERE project_id=?').get(f.project.id)).toEqual({ n: 1 })
    } finally {
      failBusinessProjectId = null
      reviseConversationProjectId = null
      mixedRecoveryProjectId = null
      legacyUntypedRecoveryProjectId = null
      await stop()
      if (f.repo) rmSync(f.repo, { recursive: true, force: true })
    }
  }
}, 30000)

test('Given 原启动因旧任务冲突停住 When 费用已核对且用户再次说继续 Then 复用原确认而不再次规划', async () => {
  const f = fixture('complete', false, false)
  failBusinessProjectId = f.project.id
  reviseConversationProjectId = f.project.id
  authorize(f, true, 6, 20_000_000)
  const stop = startOwnerManagementLoop()
  try {
    const db = store.getProjectDb()
    await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_commands c JOIN agent_executions e ON e.id=c.execution_id WHERE c.project_id=? AND c.state='settled' AND e.status='failed'").get(f.project.id)))
    const grant = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { id: string }
    const grantService = await import('./project-owner-execution-grant-issue')
    const preview = grantService.previewOwnerExecutionGrantRevoke(f.subject, { grantId: grant.id })
    grantService.confirmOwnerExecutionGrantRevoke(f.subject, { grantId: grant.id, confirmedFingerprint: preview.fingerprint })
    const oldCommand = db.prepare('SELECT id,usage_evidence FROM project_owner_execution_commands WHERE grant_id=?').get(grant.id) as { id: string; usage_evidence: string }
    db.prepare('UPDATE project_owner_execution_commands SET usage_evidence=NULL WHERE id=?').run(oldCommand.id)
    const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
    const send = (content: string) => sendOwnerManagementMessage({ ...f.subject, conversationId: getOwnerManager(f.project.id)!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content })
    send('继续完成')
    await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_start_intents WHERE project_id=? AND recovery_status='needs_attention'").get(f.project.id)))
    const intent = db.prepare("SELECT id FROM project_owner_execution_start_intents WHERE project_id=? AND recovery_status='needs_attention'").get(f.project.id) as { id: string }
    const countPlanning = () => (db.prepare("SELECT COUNT(*) AS n FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload,'$.conversationMessageId') IS NOT NULL").get(f.project.id) as { n: number }).n
    const previousPlanningCount = countPlanning()
    db.prepare('UPDATE project_owner_execution_commands SET usage_evidence=? WHERE id=?').run(oldCommand.usage_evidence, oldCommand.id)
    const message = send('继续')
    await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_start_intents WHERE id=? AND state='completed'").get(intent.id)), () => getOwnerManagementConversation(f.project.id).messages.slice(-5))
    expect(countPlanning()).toBe(previousPlanningCount)
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 2 })
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.eventId === `conversation-resumed:${message.id}`)).toBe(true)
  } finally {
    failBusinessProjectId = null
    reviseConversationProjectId = null
    await stop()
  }
}, 20000)
test('Given旧批次请求费用转待核对 When新目标已授权 Then保留旧占额且不发行新执行批次', async () => {
  const f = fixture('complete', false, false)
  authorize(f, true, 6)
  const scheduler = await import('./project-owner-autonomous-scheduler')
  const { onOwnerAutonomousScheduleWake } = await import('./project-owner-autonomous-scheduler-events')
  const stopSchedule = onOwnerAutonomousScheduleWake(id => { if (id === f.project.id) void scheduler.runOwnerAutonomousSchedule(id) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery'))
    const db = store.getProjectDb()
    const old = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { id: string }
    db.prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE command_id IN (SELECT id FROM project_owner_execution_commands WHERE grant_id=?)").run(old.id)
    saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '更新交付目标但不清除未知费用' })
    authorize(f, true, 6)
    await until(() => Boolean(db.prepare("SELECT 1 FROM project_owner_execution_start_intents WHERE project_id=? AND json_extract(payload,'$.expectedGoalRevision')=2 AND recovery_status='needs_attention'").get(f.project.id)))
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ count: 1 })
    expect((db.prepare("SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations WHERE state='needs_reconcile'").get() as { count: number }).count).toBeGreaterThan(0)
  } finally { stop(); stopSchedule() }
}, 15000)
test('Given 新项目只有Owner载体 When按方案准备团队 Then 自动在项目工作区创建所需员工和独立核验员且重复调用幂等', () => {
  const project = store.createProject({ title: '默认团队注入', description: '' }), workspace = createAgentWorkspace(`默认团队-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake default team', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const owner = employees.createAgentEmployee({ name: 'Owner', role: '项目管理者', description: '', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id], executionProfile: 'controlled', permissionMode: 'safe' })
  const binding = saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  ensureOwnerDefaultTeam(project.id, binding, ['requirements-analyst'])
  ensureOwnerDefaultTeam(project.id, binding, ['requirements-analyst'])
  const team = employees.listAgentEmployees().filter(employee => employee.id !== owner.id && employee.workspaceIds?.includes(workspace.id))
  expect(team.map(employee => employee.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
  expect(team.every(employee => employee.runtime === 'ai-sdk' && employee.executionProfile === 'controlled' && employee.permissionMode === 'safe' && employee.workspaceIds?.length === 1)).toBe(true)
})
function ownerHistoryFixture() {
  const f = fixture('missing-reviewer', false, false)
  employees.deleteAgentEmployee(f.executor.id)
  const owners = [f.owner]
  let binding = getOwnerRuntimeBinding(f.project.id)!
  for (let revision = 1; revision <= 2; revision++) {
    const owner = employees.createAgentEmployee({ name: `旧配置Owner-${revision}`, role: '项目管理者', description: '', runtime: 'ai-sdk', channelId: f.owner.channelId, modelId: f.owner.modelId, workspaceIds: [f.workspace.id], executionProfile: 'controlled', permissionMode: 'safe' })
    owners.push(owner)
    binding = saveOwnerRuntimeBinding(f.project.id, revision, { ownerName: 'Owner', carrierId: owner.id, workspaceId: f.workspace.id, changeReason: '模拟切换模型留下的载体历史' })
  }
  return { ...f, owners, binding }
}
test('Given多次更换Owner载体且没有业务员工 When准备默认团队 Then历史Owner不阻止补齐且不会成为执行或评审候选', async () => {
  const f = ownerHistoryFixture()
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst'])
  const team = employees.listAgentEmployees().filter(employee => employee.workspaceIds?.includes(f.workspace.id) && !f.owners.some(owner => owner.id === employee.id))
  expect(team.map(employee => employee.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
  const { getOwnerExecutionPreparation } = await import('./project-owner-execution-preparation')
  const choices = getOwnerExecutionPreparation(f.subject).choices.employees
  expect(choices.filter(employee => employee.isOwnerCarrier).map(employee => employee.id).sort()).toEqual(f.owners.map(owner => owner.id).sort())
  setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
})
test('Given旧Owner记录导致已确认方案缺员且事件已消费 When重启后台管理 Then自动补齐并执行评审交付而不要求再次授权', async () => {
  const f = ownerHistoryFixture(), context = plans.getProjectOwnerPlanningContext(f.project.id)
  plans.saveProjectOwnerPlanDraft(f.project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '定位研究', assumptions: [], risks: [], steps: [{ key: 'brief', title: '分析需求', outcome: '定位简报', acceptanceCriteria: ['证据和取舍明确'], dependencies: [], roleKey: 'requirements-analyst' }], changeReason: '复现已确认方案' })
  confirm(f)
  const grant = authorize(f, true)
  for (const event of listPendingOwnerManagementEvents(f.project.id)) consumeOwnerManagementEvent(event)
  const { appendOwnerManagementMessage } = await import('./project-owner-management-store')
  appendOwnerManagementMessage({ projectId: f.project.id, eventId: 'historical-team-blocked', role: 'assistant', kind: 'attention', content: '当前团队不足以同时完成执行和独立检查' })
  const scheduler = await import('./project-owner-autonomous-scheduler'), scheduleEvents = await import('./project-owner-autonomous-scheduler-events')
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(message => message.kind === 'delivery'), () => getOwnerManagementConversation(f.project.id).messages.at(-1)?.content)
    expect(delegation.getOwnerManagementDelegation(f.project.id).delegation?.id).toBe(grant.id)
    const call = calls.find(call => call.projectId === f.project.id && call.purpose === 'owner_execution_assignment')!
    expect(call.candidates).toHaveLength(2)
    expect(call.candidates.some(id => f.owners.some(owner => owner.id === id))).toBe(false)
    expect(store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE project_id=? ORDER BY role').all(f.project.id)).toEqual([{ role: 'executor', state: 'settled' }, { role: 'reviewer', state: 'settled' }])
    expect(store.listAgentExecutionsByProject(f.project.id).filter(execution => execution.ownerCommandId).every(execution => execution.sessionId)).toBe(true)
    reconcileOwnerManagement(f.project.id)
    reconcileOwnerManagement(f.project.id)
    expect(calls.filter(call => call.projectId === f.project.id && call.purpose === 'owner_execution_assignment')).toHaveLength(1)
  } finally { stopWake(); stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused') }
}, 15000)
test('Given方案也包含交付核验岗位 When创建默认团队 Then该执行岗位之外仍有另一位独立评审员', () => {
  const f = ownerHistoryFixture()
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst', 'delivery-verifier'])
  ensureOwnerDefaultTeam(f.project.id, f.binding, ['requirements-analyst', 'delivery-verifier'])
  const team = employees.listAgentEmployees().filter(employee => employee.workspaceIds?.includes(f.workspace.id) && !f.owners.some(owner => owner.id === employee.id))
  expect(team).toHaveLength(3)
  expect(team.filter(employee => employee.roleTemplateId === 'delivery-verifier')).toHaveLength(2)
  setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
})
test('Given方案岗位模板缺失 When准备默认团队 Then不留下只创建了一半的团队', () => {
  const f = ownerHistoryFixture()
  expect(ensureOwnerDefaultTeam(f.project.id, f.binding, ['missing-template'])).toBe(false)
  expect(employees.listAgentEmployees().filter(employee => employee.workspaceIds?.includes(f.workspace.id))).toHaveLength(f.owners.length)
  setOwnerManagerStatus(f.project.id, getOwnerManager(f.project.id)!.revision, 'paused')
})
test('Given 缺少独立评审员且历史含撤销提示 When 重新授权后再次核对团队 Then 当前缺员原因重新显示且不调用模型', async () => {
  const f = fixture('missing-reviewer')
  confirm(f)
  const { prepareOwnerManagementAssignment } = await import('./project-owner-management-assignment')
  const { appendOwnerManagementMessage } = await import('./project-owner-management-store')
  const check = (id: string) => prepareOwnerManagementAssignment({ id: `reauthorize:${id}`, projectId: f.project.id, kind: 'delegation_confirmed', sourceId: id, sourceRevision: 1, createdAt: Date.now(), consumedAt: null })
  const first = authorize(f)
  check(first.id)
  delegation.revokeOwnerManagementDelegation(f.project.id, first.id)
  appendOwnerManagementMessage({ projectId: f.project.id, eventId: 'old-revoked', role: 'assistant', kind: 'attention', content: '管理授权已撤销' })
  const second = authorize(f)
  const before = calls.length
  check(second.id)
  expect(getOwnerManagementConversation(f.project.id).messages.at(-1)?.content).toContain('当前团队不足以同时完成执行和独立检查')
  expect(calls.length).toBe(before)
  delegation.revokeOwnerManagementDelegation(f.project.id, second.id)
})
test('Given人员安排已准备但尚未启动 When重复核对授权 Then等待原安排且不误报终态', async () => {
  const f = fixture(), grant = authorize(f)
  confirm(f)
  const { prepareOwnerManagementAssignment } = await import('./project-owner-management-assignment')
  const event = { id: 'prepared-not-started', projectId: f.project.id, kind: 'delegation_confirmed' as const, sourceId: grant.id, sourceRevision: 1, createdAt: Date.now(), consumedAt: null }
  try {
    prepareOwnerManagementAssignment(event)
    prepareOwnerManagementAssignment({ ...event, id: 'prepared-not-started-again' })
    const runs = listOwnerExecutionAssignmentRuns(f.subject)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.executions).toHaveLength(0)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention' && item.content.includes('已结束且没有可展示的安排结论'))).toBe(false)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

async function until(predicate: () => boolean, diagnostic: () => unknown = () => undefined, attempts = 1000) { for (let i = 0; i < attempts; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error(`等待自动安排超时${JSON.stringify(diagnostic())}`) }

test('Given 已有可用团队和管理委托 When 用户确认方案 Then 无页面参与自动安排，复用已有员工且不签发执行许可', async () => {
  const f = fixture(), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    confirm(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    const runs = listOwnerExecutionAssignmentRuns(f.subject)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcomes[0]?.assignmentProposal).toMatchObject({ assignments: [{ roleKey: 'requirements-analyst', employeeId: f.executor.id }], reviewerEmployeeId: f.reviewer!.id })
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
    expect(calls.find(item => item.projectId === f.project.id)?.candidates.sort()).toEqual([f.executor.id, f.reviewer!.id].sort())
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })
    plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 2)
    reconcileOwnerManagement(f.project.id)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
  } finally { stop() }
}, 30000)

test.each(['reviewer', 'coverage'] as const)('Given 安排请求完整结束但违反%s协议 When Owner收到失败结果 Then 在原预算内只续跑一次并保留两次运行证据', async (kind) => {
  rejectNextAssignmentKind = kind
  const f = fixture()
  confirm(f)
  const grant = authorize(f, true), before = calls.length
  rejectNextAssignmentProjectId = f.project.id
  const stop = startOwnerManagementLoop()
  try {
    await until(() => calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment').length === 2
      && listOwnerExecutionAssignmentRuns(f.subject).some(run => run.outcomes.some(outcome => outcome.state === 'proposed')), () => ({ calls: calls.filter(item => item.projectId === f.project.id), events: listPendingOwnerManagementEvents(f.project.id), assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ status: run.sourceStatus, planRevision: run.link.planRevision, outcomes: run.outcomes })), messages: getOwnerManagementConversation(f.project.id).messages.slice(-5).map(item => ({ kind: item.kind, content: item.content })) }))
    const runs = listOwnerExecutionAssignmentRuns(f.subject)
    expect(runs.flatMap(run => run.outcomes.map(outcome => outcome.state)).sort()).toEqual(['failed', 'proposed'])
    expect(calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(2)
    expect(getOwnerManagementConversation(f.project.id).messages.map(item => item.content)).toContain('上一条团队安排有完整运行记录，但未通过岗位覆盖或独立评审员校验。我已在当前项目授权和预算内重新安排一次；原记录保留，不会循环重试。')
    reconcileOwnerManagement(f.project.id)
    reconcileOwnerManagement(f.project.id)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(2)
    expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('active')
  } finally { rejectNextAssignmentProjectId = null; stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 授权前已有待审方案和完整团队 When 首次确认管理委托 Then Owner自动完成内部安排并等待一次执行确认', async () => {
  const f = fixture(), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_execution_assignment'])
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged' && item.content.includes('员工尚未启动'))).toBe(true)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_task_materializations WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 员工位于未授权的共享工作区 When 团队不足 Then Owner在项目工作区自动补齐默认团队并完成安排', async () => {
  const f = fixture('complete', false, true, true, true)
  const grant = authorize(f)
  expect(teamAccess.getOwnerTeamWorkspaceProposal(f.project.id)).toMatchObject({ workspaceId: f.teamWorkspace.id, eligibleEmployeeCount: 2 })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'), () => ({
      pending: listPendingOwnerManagementEvents(f.project.id).map(event => event.kind),
      messages: getOwnerManagementConversation(f.project.id).messages.slice(-5).map(message => ({ kind: message.kind, eventId: message.eventId, hasProposal: Boolean(message.teamWorkspaceProposal), content: message.content.slice(0, 120) })),
      assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ status: run.sourceStatus, purpose: run.link.purpose })),
    }))
    // 默认建队优先：项目已授权工作区按方案自动补齐岗位团队，不要求扩大项目资料范围。
    const defaults = employees.listAgentEmployees().filter(item => item.workspaceIds?.includes(f.workspace.id) && item.id !== f.owner.id)
    expect(defaults.map(item => item.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.teamWorkspaceProposal)).toBe(false)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_workspace_bindings WHERE project_id=? AND workspace_id=?').get(f.project.id, f.teamWorkspace.id)).toEqual({ n: 0 })
    const callsForProject = calls.filter(item => item.projectId === f.project.id)
    expect(callsForProject.map(item => item.purpose)).toEqual(['owner_execution_assignment'])
    expect(callsForProject[0]!.candidates.sort()).toEqual(defaults.map(item => item.id).sort())
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 1 })
  } finally {
    stop()
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
    // 清理未占用工作区里的员工，避免污染后续测试的最小资料范围扫描。
    employees.deleteAgentEmployee(f.executor.id)
    if (f.reviewer) employees.deleteAgentEmployee(f.reviewer.id)
  }
})

test('Given 可计费Pi团队位于未授权工作区 When Owner检查执行能力 Then 在项目工作区自动补齐默认团队并完成安排', async () => {
  const f = fixture('pi-team', false, true, true, true), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'), () => ({
      messages: getOwnerManagementConversation(f.project.id).messages.slice(-8).map(message => ({ kind: message.kind, content: message.content.slice(0, 100) })),
      events: listPendingOwnerManagementEvents(f.project.id).map(event => event.kind),
      assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ status: run.sourceStatus, outcomes: run.outcomes.map(outcome => ({ state: outcome.state, detail: outcome.detail })) })),
      executions: store.listAgentExecutionsByProject(f.project.id).map(execution => ({ status: execution.status, error: execution.error, agentId: execution.agentId, entityId: execution.entityId })),
      links: store.getProjectDb().prepare('SELECT planning_task_id, payload FROM project_owner_planning_links WHERE project_id=?').all(f.project.id),
    }))
    // 默认建队优先：不在项目授权工作区里的 Pi 团队不会被自动挪用，改为在项目工作区补齐默认团队。
    const defaults = employees.listAgentEmployees().filter(item => item.workspaceIds?.includes(f.workspace.id) && item.id !== f.owner.id)
    expect(defaults.map(item => item.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.teamWorkspaceProposal)).toBe(false)
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_execution_assignment'])
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 1 })
  } finally {
    stop()
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
    // 清理未占用共享工作区里的员工，避免污染后续测试的资料范围扫描。
    employees.deleteAgentEmployee(f.executor.id)
    if (f.reviewer) employees.deleteAgentEmployee(f.reviewer.id)
  }
})

test('Given可降级的Pi研发员工位于未授权Git工作区 When默认建队可行 Then优先在项目工作区补齐受控默认团队且不改已有员工', async () => {
  const f = fixture('pi-development-team', false, true, true, true), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    // 纯函数行为保留：默认建队守卫之外，仍能对未占用工作区提出最小资料范围建议。
    const proposal = teamAccess.getOwnerTeamWorkspaceProposal(f.project.id)
    if (!proposal) throw new Error('预期存在 Pi 团队工作区提议')
    expect(proposal).toMatchObject({ workspaceId: f.teamWorkspace.id, eligibleEmployeeCount: 2 })
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'), () => ({ messages: getOwnerManagementConversation(f.project.id).messages.slice(-6).map(item => ({ kind: item.kind, content: item.content.slice(0, 120) })), assignments: listOwnerExecutionAssignmentRuns(f.subject).map(run => run.outcomes.map(outcome => ({ state: outcome.state, detail: outcome.detail }))), calls: calls.filter(item => item.projectId === f.project.id) }))
    const defaults = employees.listAgentEmployees().filter(item => item.workspaceIds?.includes(f.workspace.id) && item.id !== f.owner.id)
    expect(defaults.map(item => item.roleTemplateId).sort()).toEqual(['delivery-verifier', 'requirements-analyst'])
    // 自动补队不改动既有员工档案。
    expect(employees.getAgentEmployee(f.executor.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'safe' })
    expect(employees.getAgentEmployee(f.reviewer!.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'safe' })
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_execution_assignment'])
  } finally {
    stop()
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
    employees.deleteAgentEmployee(f.executor.id)
    if (f.reviewer) employees.deleteAgentEmployee(f.reviewer.id)
  }
}, 15_000)

test('Given 项目工作区已有业务员工但缺独立评审 When 存在含合格员工的未占用工作区 Then 建议纳入资料范围且不另建默认团队', async () => {
  const f = fixture('missing-reviewer')
  const shared = createAgentWorkspace(`共享团队-${randomUUID()}`)
  const sharedChannel = createChannel({ name: 'fake shared', provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: 'glm', enabled: true }] })
  employees.createAgentEmployee({ name: '共享执行', role: '共享执行', roleTemplateId: 'requirements-analyst', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: sharedChannel.id, modelId: 'glm-5.3-flash', workspaceIds: [shared.id] })
  employees.createAgentEmployee({ name: '共享评审', role: '共享评审', roleTemplateId: 'delivery-verifier', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: sharedChannel.id, modelId: 'glm-5.3-flash', workspaceIds: [shared.id] })
  const grant = authorize(f)
  expect(teamAccess.getOwnerTeamWorkspaceProposal(f.project.id)).toMatchObject({ workspaceId: shared.id, eligibleEmployeeCount: 2 })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.teamWorkspaceProposal), () => ({
      pending: listPendingOwnerManagementEvents(f.project.id).map(event => event.kind),
      messages: getOwnerManagementConversation(f.project.id).messages.slice(-5).map(message => ({ kind: message.kind, hasProposal: Boolean(message.teamWorkspaceProposal), content: message.content.slice(0, 120) })),
    }))
    const suggestion = getOwnerManagementConversation(f.project.id).messages.find(item => item.teamWorkspaceProposal)!
    expect(suggestion.teamWorkspaceProposal).toMatchObject({ workspaceId: shared.id })
    // 项目工作区已有业务员工，默认建队守卫生效：不另建团队，等待用户决定资料范围。
    expect(employees.listAgentEmployees().filter(item => item.workspaceIds?.includes(f.workspace.id) && item.id !== f.owner.id)).toHaveLength(1)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    const approval = { projectId: f.project.id, messageId: suggestion.id, workspaceId: shared.id, scopeFingerprint: suggestion.teamWorkspaceProposal!.scopeFingerprint }
    teamAccess.confirmOwnerTeamWorkspaceAccess(approval)
    teamAccess.confirmOwnerTeamWorkspaceAccess(approval)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_workspace_bindings WHERE project_id=? AND workspace_id=?').get(f.project.id, shared.id)).toEqual({ n: 1 })
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.eventId === `team-workspace-approved:${suggestion.id}`)).toHaveLength(1)
  } finally {
    stop()
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
    // 清理共享工作区员工，避免未占用工作区污染后续测试的资料范围扫描。
    for (const employee of employees.listAgentEmployees()) {
      if (employee.workspaceIds?.includes(shared.id)) employees.deleteAgentEmployee(employee.id)
    }
  }
}, 15_000)

test('Given 待审方案的授权事件已消费但没有安排记录 When Owner循环恢复项目 Then 只重新检查一次并把缺少团队的原因带回对话', () => {
  const f = fixture(), grant = authorize(f), before = calls.filter(item => item.projectId === f.project.id).length
  store.getProjectDb().prepare('UPDATE agent_employees SET enabled = 0 WHERE id IN (?, ?)').run(f.executor.id, f.reviewer!.id)
  for (const event of listPendingOwnerManagementEvents(f.project.id)) consumeOwnerManagementEvent(event)
  try {
    reconcileOwnerManagement(f.project.id)
    const event = store.getProjectDb().prepare("SELECT payload, consumed_at FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck'").get(f.project.id) as { payload: string; consumed_at: number | null }
    expect(event.consumed_at).toBeNull()
    expect(JSON.parse(event.payload)).toMatchObject({ kind: 'assignment_recheck', sourceRevision: f.plan!.revision, sourceId: grant.id })
    reconcileOwnerManagement(f.project.id)
    expect(store.getProjectDb().prepare("SELECT consumed_at FROM project_owner_management_events WHERE project_id = ? AND json_extract(payload, '$.kind') = 'assignment_recheck'").get(f.project.id)).toMatchObject({ consumed_at: expect.any(Number) })
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'attention').map(item => item.content)).toContainEqual(expect.stringContaining('没有能承担这项工作的员工'))
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(before)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 已确认方案和有效管理授权 When 用户手动重新安排 Then 后台消费请求并准备一次新安排', () => {
  const f = fixture(), grant = authorize(f)
  try {
    confirm(f)
    for (const event of listPendingOwnerManagementEvents(f.project.id)) consumeOwnerManagementEvent(event)
    expect(retakeOwnerManagementAssignment({ ...f.subject, requestId: randomUUID() })).toEqual({ enqueued: true })
    reconcileOwnerManagement(f.project.id)
    const runs = listOwnerExecutionAssignmentRuns(f.subject)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.link.requestId).toStartWith('management-assignment:')
    expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'attention').map(item => item.content)).not.toContain('当前方案或持续管理授权已变化，我已停止使用旧安排条件；请在项目对话中核对最新方案与管理范围。')
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
})

test('Given 手动重排已排队 When 管理授权在消费前被撤销 Then 不准备新安排', () => {
  const f = fixture(), grant = authorize(f)
  confirm(f)
  for (const event of listPendingOwnerManagementEvents(f.project.id)) consumeOwnerManagementEvent(event)
  expect(retakeOwnerManagementAssignment({ ...f.subject, requestId: randomUUID() })).toEqual({ enqueued: true })
  delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
  reconcileOwnerManagement(f.project.id)
  expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
})

test('Given 已保存目标与已授权的项目费用边界 When 后台开始管理 Then Owner自动规划并安排团队，等待用户确认执行', async () => {
  const f = fixture('complete', false, false, true), grant = authorize(f), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    const projectCalls = calls.slice(before).filter(item => item.projectId === f.project.id)
    expect(projectCalls.map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    expect(plans.getProjectOwnerPlanDraft(f.project.id)).toMatchObject({ state: 'proposed', origin: 'generated' })
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(2)
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(2)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'plan_proposal')).toBe(true)
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged')).toBe(true)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 30000)

test('Given 已审核价格模型但没有项目费用授权 When Owner收到目标 Then 等待用户补齐边界且不发送请求', async () => {
  const f = fixture('complete', false, false, true), before = calls.length, stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.length > 0)
    expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
    expect(calls.slice(before).filter(item => item.projectId === f.project.id)).toHaveLength(0)
    expect(store.listAgentExecutionsByProject(f.project.id)).toHaveLength(0)
    expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('none')
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'plan_proposal')).toBe(false)
  } finally { stop() }
})

test('Given Owner生成了待审方案和有效规划委托 When 方案展示给用户 Then团队已内部安排但没有启动员工', async () => {
  const f = fixture('complete', false, false), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(2)
    const trace = getOwnerManagementView(f.project.id).trace ?? []
    const latestTrace = trace.at(-1)
    if (!latestTrace) throw new Error('Owner安排未生成诊断Trace')
    expect(trace.map(item => [item.phase, item.state])).toContainEqual(['assignment_preparation', 'completed'])
    expect(trace.map(item => [item.phase, item.state])).toContainEqual(['assignment_run', 'completed'])
    expect(trace.every(item => !('content' in item) && !('prompt' in item) && !('response' in item))).toBe(true)
    expect(trace.every(item => /^[a-f0-9]{64}$/.test(item.eventId))).toBe(true)
    expect(appendOwnerManagementTrace(latestTrace)).toEqual(latestTrace)
    expect(appendOwnerManagementTrace({ ...latestTrace, createdAt: latestTrace.createdAt + 1 })).toEqual(latestTrace)
    const changes: { projectId: string; messageId?: string }[] = [], off = onOwnerManagementChanged(change => { if (change.projectId === f.project.id) changes.push(change) })
    appendOwnerManagementTrace({ ...latestTrace, eventId: randomUUID(), createdAt: latestTrace.createdAt + 2 })
    await new Promise(resolve => setTimeout(resolve, 0))
    off()
    expect(changes).toEqual([{ projectId: f.project.id }])
    expect(() => appendOwnerManagementTrace({ ...latestTrace, unexpected: 'secret' } as never)).toThrow('字段无效')
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given管理循环已运行且目标尚无计划 When首次规划后 Then自动安排团队但等待用户确认才启动员工', async () => {
  const f = fixture('complete', false, false), before = calls.length, stop = startOwnerManagementLoop()
  const grant = authorize(f)
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(calls.slice(before).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(2)
    expect(store.listAgentExecutionsByProject(f.project.id).every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })
    expect(delegation.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active', usedRequests: 2 })
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); stop() }
}, 15_000)

test('Given 用户在项目对话提交新目标及总预算 When Owner规划并内部安排、用户确认执行 Then完成后续交付流程', async () => {
  const { createStore } = await import('jotai')
  const goalAtoms = await import('../../renderer/atoms/project-owner-goal-atoms')
  const planAtoms = await import('../../renderer/atoms/project-owner-plan-atoms')
  const runtimeAtoms = await import('../../renderer/atoms/project-owner-runtime-atoms')
  const setupAtoms = await import('../../renderer/atoms/owner-setup-atoms')
  const goals = await import('./project-owner-goal-service')
  const ownerBinding = await import('./project-owner-runtime-binding')
  const { listOwnerPlanningRuns } = await import('./project-owner-runtime-ipc')
  const workspaces = await import('./agent-workspace-manager')
  const bindings = await import('./project-workspace-bindings')
  const channels = await import('./channel-manager')
  const f = fixture('complete', false, false, false), state = createStore(), callsBefore = calls.length
  state.set(goalAtoms.ownerGoalApiAtom, {
    getOwnerGoalDraft: async subject => ({ ok: true as const, value: goals.getProjectOwnerGoalDraft(subject.projectId, subject.taskId) }),
    saveOwnerGoalDraft: async request => ({ ok: true as const, value: saveProjectOwnerGoalDraft(request.projectId, request.expectedRevision, request.input, request.taskId) }),
  })
  state.set(planAtoms.ownerPlanApiAtom, {
    getOwnerPlanningContext: async subject => ({ ok: true as const, value: plans.getProjectOwnerPlanningContext(subject.projectId, subject.taskId) }),
    getOwnerPlanDraft: async subject => ({ ok: true as const, value: plans.getProjectOwnerPlanDraft(subject.projectId, subject.taskId) }),
    listOwnerPlanHistory: async subject => ({ ok: true as const, value: plans.listProjectOwnerPlanHistory(subject.projectId, subject.taskId) }),
    saveOwnerPlanDraft: async request => ({ ok: true as const, value: plans.saveProjectOwnerPlanDraft(request.projectId, request.expectedGoalRevision, request.expectedRevision, request.input, request.taskId) }),
    confirmOwnerPlanDraft: async request => ({ ok: true as const, value: plans.confirmProjectOwnerPlanDraft(request.projectId, request.expectedGoalRevision, request.expectedRevision, request.taskId) }),
  })
  state.set(runtimeAtoms.ownerRuntimeApiAtom, {
    getOwnerRuntimeBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    ensureOwnerRuntimeBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    createOwnerDedicatedWorkspace: async () => ({ ok: false as const, error: { code: 'failed', message: '测试不提供Owner专用工作区' } }),
    saveOwnerRuntimeBinding: async request => ({ ok: true as const, value: ownerBinding.saveOwnerRuntimeBinding(request.projectId, request.expectedRevision, request.input) }),
    getOwnerPlanningContext: async subject => ({ ok: true as const, value: plans.getProjectOwnerPlanningContext(subject.projectId, subject.taskId) }),
    listOwnerPlanningRuns: async subject => ({ ok: true as const, value: listOwnerPlanningRuns(subject.projectId, subject.taskId) }),
    prepareOwnerPlanning: async request => ({ ok: true as const, value: ownerBinding.prepareOwnerPlanning(request.projectId, request.input) }),
    listEmployees: async () => employees.listAgentEmployees().map(employee => ({ ...employee, skills: employee.skills ?? [] })),
    listWorkspaces: async () => workspaces.listAgentWorkspaces(),
    listWorkspaceBindings: async projectId => bindings.listProjectWorkspaceBindings(projectId),
  })
  state.set(setupAtoms.ownerSetupApiAtom, {
    listChannels: async () => channels.listChannels().map(({ id, name, provider, models, enabled, updatedAt }) => ({ id, name, provider, models, enabled, updatedAt })),
    listEmployees: async () => employees.listAgentEmployees().map(employee => ({ ...employee, skills: employee.skills ?? [] })),
    listWorkspaces: async () => workspaces.listAgentWorkspaces(),
    listBindings: async projectId => bindings.listProjectWorkspaceBindings(projectId),
    getBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    ensureBinding: async subject => ({ ok: true as const, value: ownerBinding.getOwnerRuntimeBinding(subject.projectId) }),
    saveBinding: async request => ({ ok: true as const, value: ownerBinding.saveOwnerRuntimeBinding(request.projectId, request.expectedRevision, request.input) }),
    createWorkspace: async name => workspaces.createAgentWorkspace(name),
    bindWorkspace: async (projectId, workspaceId) => bindings.bindWorkspaceToProject(projectId, workspaceId),
    createEmployee: async input => ({ ...employees.createAgentEmployee(input), skills: [] }),
    authorizeOwnerManagement: async input => {
      const preview = delegation.previewOwnerManagementDelegation(input)
      return { ok: true as const, value: delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash }) }
    },
  })
  const subject = { projectId: f.project.id }
  await state.set(goalAtoms.loadOwnerGoalAtom, subject)
  state.set(goalAtoms.editOwnerGoalAtom, { subject, patch: { objective: '为新产品确定首批用户和切入市场', constraintsText: '仅使用本项目资料', criteriaText: '结论附依据与主要不确定性' } })
  await state.set(setupAtoms.loadOwnerSetupAtom, subject)
  const stop = startOwnerManagementLoop()
  try {
    const planningPromise = state.set(setupAtoms.startOwnerPlanningWithBudgetAtom, { subject, budgetUsd: '15', hours: '24', authorizePlanning: true })
    await planningPromise
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    const savedGoal = goals.getProjectOwnerGoalDraft(f.project.id)
    const proposedPlan = plans.getProjectOwnerPlanDraft(f.project.id)
    expect(savedGoal?.goal.objective).toBe('为新产品确定首批用户和切入市场')
    expect(proposedPlan?.state).toBe('proposed')
    expect(proposedPlan?.proposal.summary).toBe('按目标形成定位简报')
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged')).toBe(true)
    expect(calls.slice(callsBefore).filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment'])
    const arrangementCall = calls.find(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')
    if (!arrangementCall) throw new Error('Owner没有提交团队安排请求')
    expect([...arrangementCall.candidates].sort()).toEqual([f.executor.id, f.reviewer!.id].sort())
    const ownerExecutions = store.listAgentExecutionsByProject(f.project.id)
    expect(ownerExecutions.length).toBeGreaterThan(0)
    expect(ownerExecutions.every(item => item.agentId === f.owner.id)).toBe(true)
    for (const table of ['project_owner_execution_grants', 'project_owner_task_materializations']) expect(store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(f.project.id)).toEqual({ n: 0 })

    const executionAtoms = await import('../../renderer/atoms/project-owner-execution-atoms')
    const assignmentAtoms = await import('../../renderer/atoms/project-owner-execution-assignment-atoms')
    const taskAtoms = await import('../../renderer/atoms/project-owner-task-atoms')
    const revalidationAtoms = await import('../../renderer/atoms/project-owner-execution-revalidation-atoms')
    const grantAtoms = await import('../../renderer/atoms/project-owner-execution-grant-atoms')
    const deliveryAtoms = await import('../../renderer/atoms/owner-delivery-flow-atoms')
    const { registerProjectOwnerExecutionIpcHandlers } = await import('./project-owner-execution-ipc')
    registerProjectOwnerExecutionIpcHandlers({ handle: (channel, handler) => { ipcHandlers.set(channel, handler) } })
    const executionService = await import('./project-owner-execution-preparation')
    const taskService = await import('./project-owner-task-materialization')
    const revalidationService = await import('./project-owner-execution-revalidation')
    const grantService = await import('./project-owner-execution-grant-issue')
    const renewalService = await import('./project-owner-execution-grant-renewal')
    const setup = await import('../../renderer/atoms/owner-execution-setup')
    state.set(assignmentAtoms.ownerExecutionAssignmentApiAtom, {
      prepareOwnerExecutionAssignment: async request => ({ ok: true as const, value: (await import('./project-owner-execution-assignment-service')).prepareOwnerExecutionAssignment(request, request.input) }),
      listOwnerExecutionAssignmentRuns: async subject => ({ ok: true as const, value: listOwnerExecutionAssignmentRuns(subject) }),
    })
    state.set(executionAtoms.ownerExecutionApiAtom, {
      getOwnerExecutionPreparation: async subject => ({ ok: true as const, value: executionService.getOwnerExecutionPreparation(subject) }),
      listOwnerExecutionPreparationHistory: async subject => ({ ok: true as const, value: executionService.listOwnerExecutionPreparationHistory(subject) }),
      previewOwnerExecutionPreparation: async request => ({ ok: true as const, value: executionService.previewOwnerExecutionPreparation(request, request.input) }),
      saveOwnerExecutionPreparation: async request => ({ ok: true as const, value: executionService.saveOwnerExecutionPreparation(request, request.input, request.previewFingerprint) }),
    })
    state.set(taskAtoms.ownerTaskApiAtom, {
      getOwnerTaskMaterialization: async subject => ({ ok: true as const, value: taskService.getOwnerTaskMaterialization(subject) }),
      listOwnerTaskMaterializationHistory: async subject => ({ ok: true as const, value: taskService.listOwnerTaskMaterializationHistory(subject) }),
      previewOwnerTaskMaterialization: async request => ({ ok: true as const, value: taskService.previewOwnerTaskMaterialization(request, request.input) }),
      materializeOwnerTasks: async request => ({ ok: true as const, value: taskService.materializeOwnerTasks(request, request.input, request.previewFingerprint) }),
    })
    state.set(taskAtoms.ownerTaskRefreshAtom, { listTasks: async () => undefined })
    state.set(revalidationAtoms.ownerRevalidationApiAtom, {
      getOwnerExecutionRevalidation: async subject => ({ ok: true as const, value: revalidationService.getOwnerExecutionRevalidation(subject) }),
      listOwnerExecutionRevalidationHistory: async subject => ({ ok: true as const, value: revalidationService.listOwnerExecutionRevalidationHistory(subject) }),
      previewOwnerExecutionRevalidation: async request => ({ ok: true as const, value: revalidationService.previewOwnerExecutionRevalidation(request, request.input) }),
      saveOwnerExecutionRevalidation: async request => ({ ok: true as const, value: revalidationService.saveOwnerExecutionRevalidation(request, request.input, request.previewFingerprint) }),
    })
    state.set(grantAtoms.ownerGrantApiAtom, {
      getOwnerExecutionGrant: async subject => ({ ok: true as const, value: grantService.getOwnerExecutionGrant(subject) }),
      listOwnerExecutionGrantHistory: async subject => ({ ok: true as const, value: grantService.listOwnerExecutionGrantHistory(subject) }),
      previewOwnerExecutionGrantIssue: async request => ({ ok: true as const, value: grantService.previewOwnerExecutionGrantIssue(request, request.input) }),
      confirmOwnerExecutionGrantIssue: async request => ({ ok: true as const, value: grantService.confirmOwnerExecutionGrantIssue(request, { input: request.input, preview: request.preview, confirmedFingerprint: request.confirmedFingerprint }) }),
      previewOwnerExecutionGrantRevoke: async request => ({ ok: true as const, value: grantService.previewOwnerExecutionGrantRevoke(request, { grantId: request.grantId }) }),
      confirmOwnerExecutionGrantRevoke: async request => ({ ok: true as const, value: grantService.confirmOwnerExecutionGrantRevoke(request, { grantId: request.grantId, confirmedFingerprint: request.confirmedFingerprint }) }),
      previewOwnerExecutionGrantRenewal: async request => ({ ok: true as const, value: renewalService.previewOwnerExecutionGrantRenewal(request, request.input) }),
      confirmOwnerExecutionGrantRenewal: async request => ({ ok: true as const, value: renewalService.confirmOwnerExecutionGrantRenewal(request, { input: request.input, preview: request.preview, confirmedFingerprint: request.confirmedFingerprint }) }),
    })
    state.set(deliveryAtoms.ownerExecutionLaunchApiAtom, {
      saveOwnerExecutionStartIntent: async request => await ipcHandlers.get(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['saveOwnerExecutionStartIntent']>>,
      resumeOwnerExecutionStartIntent: async request => await ipcHandlers.get(PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['resumeOwnerExecutionStartIntent']>>,
    })
    const executionSubject = { projectId: f.project.id }
    await state.set(planAtoms.loadOwnerPlanAtom, executionSubject)
    await state.set(assignmentAtoms.loadOwnerExecutionAssignmentRunsAtom, executionSubject)
    await state.set(executionAtoms.loadOwnerExecutionAtom, executionSubject)
    const runs = assignmentAtoms.getOwnerExecutionAssignmentEditor(state.get(assignmentAtoms.ownerExecutionAssignmentEditorsAtom), executionSubject).runs
    const proposal = runs.at(-1)?.outcomes[0]?.assignmentProposal
    if (!proposal) throw new Error('Owner安排结果中缺少可确认的团队提案')
    const projectBudget = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    const limits = setup.ownerExecutionSuggestedLimits(proposal.selectedStepKeys.length)
    const expiresAt = new Date(projectBudget.expiresAt - 60_000)
    expiresAt.setMinutes(expiresAt.getMinutes() - expiresAt.getTimezoneOffset())
    state.set(executionAtoms.editOwnerExecutionAtom, { subject: executionSubject, patch: {
      ...setup.ownerExecutionAssignmentEdit(proposal), ...limits,
      maxCostMicrosText: String(projectBudget.maxCostMicros - delegation.getOwnerManagementDelegation(f.project.id).reservedCostMicros),
      expiresAtText: expiresAt.toISOString().slice(0, 16),
      changeReason: '用户确认结果范围与项目总预算',
    } })
    expect(executionAtoms.ownerExecutionInput(state.get, executionSubject, true)).not.toBeNull()
    const scheduler = await import('./project-owner-autonomous-scheduler')
    const scheduleEvents = await import('./project-owner-autonomous-scheduler-events')
    const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
    try {
      await state.set(deliveryAtoms.reviewOwnerManagedExecutionAtom, executionSubject)
      await until(() => store.listAgentExecutionsByProject(f.project.id).some(item => item.ownerCommandId && item.status === 'completed'))
      await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery' || item.kind === 'attention'))
      if (!getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'delivery')) {
        const outcomes = store.getProjectDb().prepare('SELECT e.status,e.error,o.payload FROM agent_executions e LEFT JOIN project_owner_planning_run_outcomes o ON o.execution_id=e.id WHERE e.project_id=?').all(f.project.id)
        const commands = store.getProjectDb().prepare('SELECT role,state,execution_id FROM project_owner_execution_commands WHERE project_id=?').all(f.project.id)
        const reviews = store.getProjectDb().prepare('SELECT verdict,response_json FROM project_owner_technical_reviews WHERE project_id=?').all(f.project.id)
        throw new Error(`Owner交付未完成：${JSON.stringify({ outcomes, commands, reviews })}`)
      }
      expect(getOwnerManagementConversation(f.project.id).messages.filter(item => item.kind === 'attention').map(item => item.content)).toEqual([])
      const intent = store.getProjectDb().prepare('SELECT state,grant_id FROM project_owner_execution_start_intents WHERE project_id=?').get(f.project.id) as { state: string; grant_id: string }
      expect(intent.state).toBe('completed')
      expect(intent.grant_id).toBeTruthy()
      expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('confirmed')
      expect(grantService.getOwnerExecutionGrant(executionSubject)?.dispatchMode).toBe('autonomous')
      expect(store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE project_id=? ORDER BY role').all(f.project.id)).toEqual([{ role: 'executor', state: 'settled' }, { role: 'reviewer', state: 'settled' }])
      expect(store.getProjectDb().prepare("SELECT json_extract(payload,'$.state') AS state FROM project_owner_quality_actions WHERE project_id=?").all(f.project.id)).toEqual([{ state: 'accepted' }])
      const delivery = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'delivery')
      expect(delivery?.conversationId).toBe(getOwnerManager(f.project.id)?.conversationId)
      expect(delivery?.delivery?.items[0]?.content).toContain('已整理目标范围、证据和取舍')
      expect(calls.filter(item => item.projectId === f.project.id).map(item => item.purpose)).toEqual(['owner_planning', 'owner_execution_assignment', 'owner_quality'])
    } finally { stopWake() }
  } finally {
    stop()
    const grant = delegation.getOwnerManagementDelegation(f.project.id)
    if (grant.state === 'active' && grant.delegation) delegation.revokeOwnerManagementDelegation(f.project.id, grant.delegation.id)
  }
}, 15_000)

test('Given 首次待审方案及项目绑定资料 When Owner自主安排 Then 保留资料范围完成启动绑定并仅显示真实门禁', async () => {
  const f = fixture()
  const sourceDirectory = join(directory, `knowledge-${randomUUID()}`)
  mkdirSync(sourceDirectory, { recursive: true })
  writeFileSync(join(sourceDirectory, 'brief.md'), '# 项目资料\n\n仅用于核对资料是否进入冻结执行范围。', 'utf8')
  const catalog = await import('./knowledge-catalog-service')
  const source = catalog.createSource({ type: 'vault', name: '项目授权资料', locator: sourceDirectory })
  const knowledgeBase = catalog.createKnowledgeBase({ name: '项目资料库', sourceIds: [source.id] })
  catalog.bindProject({ projectId: f.project.id, knowledgeBaseId: knowledgeBase.id })
  const input = { ...f.subject, requestId: randomUUID(), maxRequests: Number.MAX_SAFE_INTEGER, autonomousExecution: true as const, maxCostMicros: 15_000_000, expiresAt: Date.now() + 24 * 3600000 }
  const preview = delegation.previewOwnerManagementDelegation(input)
  const issued = delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
  const scheduler = await import('./project-owner-autonomous-scheduler'), scheduleEvents = await import('./project-owner-autonomous-scheduler-events')
  const stopWake = scheduleEvents.onOwnerAutonomousScheduleWake(projectId => { if (projectId === f.project.id) void scheduler.runOwnerAutonomousSchedule(projectId) })
  const stop = startOwnerManagementLoop()
  try {
    await until(() => {
      const intent = store.getProjectDb().prepare("SELECT state FROM project_owner_execution_start_intents WHERE project_id=?").get(f.project.id) as { state: string } | undefined
      return intent?.state === 'completed'
    })
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('confirmed')
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.actor).toBe('system:owner-manager')
    expect(calls.some(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toBe(true)
    const intent = store.getProjectDb().prepare('SELECT payload,state,grant_id FROM project_owner_execution_start_intents WHERE project_id=?').get(f.project.id) as { payload: string; state: string; grant_id: string }
    expect(intent).toBeTruthy()
    expect(intent.state).toBe('completed')
    expect(intent.grant_id).toBeTruthy()
    expect(JSON.parse(intent.payload).input.knowledgeSourceIds).toEqual([source.id])
    expect(JSON.parse(intent.payload).input).toMatchObject({ maxRework: 2, maxRuns: 6 })
    const prep = (await import('./project-owner-execution-preparation')).getOwnerExecutionPreparation(f.subject)
    expect(prep.blockers).not.toContain('尚无权威业务任务与步骤关联，不能发行执行许可')
    expect(prep.blockers).not.toContain('执行侧资料与逐请求Owner来源门禁尚未接通')
    expect(prep.blockers).not.toContain('拟议预算不是已预留额度，不承诺金额硬封顶')
    expect(prep.blockers).not.toContain('非代码Pilot发行与资料适配器尚未接通')
    expect(getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'management_progress' && item.content.includes('正在按你确认的方案和预算核验工作范围并启动团队'))).toBe(true)
  } finally { stopWake(); stop(); delegation.revokeOwnerManagementDelegation(f.project.id, issued.id) }
}, 15000)

test('Given 旧启动意图按方案顺序选择了executor When岗位冻结按roleKey排序 Then 自动对齐兼容输入并安全续接原意图', async () => {
  const f = fixture('complete', false, false)
  const visual = employees.createAgentEmployee({ name: '视觉设计师', role: '视觉设计师', roleTemplateId: 'visual-designer', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: f.owner.channelId, modelId: f.owner.modelId, workspaceIds: [f.workspace.id] })
  const context = plans.getProjectOwnerPlanningContext(f.project.id)!
  plans.saveProjectOwnerPlanDraft(f.project.id, 1, 0, {
    expectedContextFingerprint: context.fingerprint,
    summary: '按不同顺序完成两项成果', assumptions: [], risks: [],
    steps: [
      { key: 'visual', title: '先完成视觉', outcome: '视觉说明', acceptanceCriteria: ['布局清晰'], dependencies: [], roleKey: 'visual-designer' },
      { key: 'requirements', title: '再完成需求', outcome: '需求说明', acceptanceCriteria: ['规则清楚'], dependencies: ['visual'], roleKey: 'requirements-analyst' },
    ],
    changeReason: '覆盖方案顺序与稳定岗位排序不同的旧启动意图',
  })
  const issued = authorize(f, true)
  const { getOwnerExecutionPreparation } = await import('./project-owner-execution-preparation')
  const { saveOwnerExecutionStartIntent, resumeOwnerExecutionStartIntent } = await import('./project-owner-execution-start-intent')
  const plan = plans.getProjectOwnerPlanDraft(f.project.id)!
  const input: OwnerExecutionPreparationInput = {
    requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null,
    expectedGoalRevision: plan.goalRevision, expectedPlanRevision: plan.revision,
    selectedStepKeys: ['visual', 'requirements'], executionKind: 'controlled', employeeRuntimeVersion: 2,
    textDeliveryVersion: 1, qualityManagementVersion: 1,
    executorEmployeeId: visual.id, reviewerEmployeeId: f.reviewer!.id,
    roleAssignments: [
      { roleKey: 'requirements-analyst', employeeId: f.executor.id },
      { roleKey: 'visual-designer', employeeId: visual.id },
    ],
    workspaceId: f.workspace.id, acknowledgeOwnerWorkspaceOverride: true, knowledgeSourceIds: [],
    maxCostMicros: issued.maxCostMicros, maxRuns: 12, maxRework: 2,
    expiresAt: issued.expiresAt, changeReason: '用户已确认方案范围与项目预算',
  }
  const intent = saveOwnerExecutionStartIntent({ ...f.subject, intentId: input.requestId, expectedGoalRevision: plan.goalRevision,
    expectedPlanRevision: plan.revision, planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input })
  await expect(resumeOwnerExecutionStartIntent(intent.intentId, undefined, { launch: async () => { throw new Error('TEST_STOP_BEFORE_PROVIDER') } })).rejects.toThrow('TEST_STOP_BEFORE_PROVIDER')
  const preparation = getOwnerExecutionPreparation(f.subject).preparation
  expect(preparation?.input.roleAssignments?.map(item => item.roleKey)).toEqual(['requirements-analyst', 'visual-designer'])
  expect(preparation?.input.executorEmployeeId).toBe(f.executor.id)
  expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id)).toBeUndefined()
  delegation.revokeOwnerManagementDelegation(f.project.id, issued.id)
})

test('Given Owner规划请求执行中持续管理授权被撤销 When提案返回 Then保存方案但不准备团队安排并明确显示未派工', async () => {
  const f = fixture('complete', false, false)
  let markStarted!: () => void, releaseResponse!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
  nextOwnerPlanningResponseGate = { started: markStarted, wait: responseGate }
  const issued = authorize(f, true), stop = startOwnerManagementLoop()
  try {
    await started
    delegation.revokeOwnerManagementDelegation(f.project.id, issued.id)
    releaseResponse()
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'plan_proposal'))
    const proposalMessage = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'plan_proposal')
    expect(proposalMessage?.content).toContain('当前持续管理授权已失效')
    expect(proposalMessage?.content).toContain('没有安排团队或启动员工')
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    expect(calls.filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(0)
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_commands WHERE project_id=?').get(f.project.id)).toMatchObject({ n: 0 })
  } finally {
    releaseResponse()
    nextOwnerPlanningResponseGate = null
    stop()
    delegation.revokeOwnerManagementDelegation(f.project.id, issued.id)
  }
}, 15000)

test('Given 最后一次管理请求用于团队安排 When 安排完成但预算请求数已耗尽 Then Owner停住并说明未启动员工', async () => {
  const f = fixture(), proposed = f.plan!
  const input = { ...f.subject, requestId: randomUUID(), maxRequests: 1, maxCostMicros: 15_000_000, expiresAt: Date.now() + 24 * 3600000,
    startApproval: { expectedGoalRevision: proposed.goalRevision, expectedPlanRevision: proposed.revision, planFingerprint: proposed.planFingerprint, contextFingerprint: proposed.contextFingerprint } }
  const preview = delegation.previewOwnerManagementDelegation(input)
  const issued = delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash }), stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention' && item.content.includes('预算')))
    expect(store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_execution_start_intents WHERE project_id=?").get(f.project.id)).toMatchObject({ n: 0 })
    expect(store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_execution_grants WHERE project_id=?").get(f.project.id)).toMatchObject({ n: 0 })
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, issued.id) }
}, 15_000)

test('Given 已确认方案但没有管理委托 When 后台处理 Then 仅准备一次不收费，重开及重复确认复用同记录', async () => {
  const f = fixture(); confirm(f); reconcileOwnerManagement(f.project.id)
  const first = listOwnerExecutionAssignmentRuns(f.subject)
  expect(first).toHaveLength(1)
  store.closeProjectDb(); await store.initProjectDb()
  const stop = startOwnerManagementLoop()
  try {
    plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 2); reconcileOwnerManagement(f.project.id)
    expect(listOwnerExecutionAssignmentRuns(f.subject)[0]?.link.id).toBe(first[0]?.link.id)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(0)
  } finally { stop() }
}, 15_000)

test('Given 现有团队缺独立评审 When 确认方案 Then 说明阻塞和可调整边界，不浪费安排请求', async () => {
  for (const team of ['missing-reviewer'] as const) {
    const f = fixture(team), grant = authorize(f); confirm(f); reconcileOwnerManagement(f.project.id)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    const attention = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'attention')
    expect(attention?.content).toContain('还没有派工')
    expect(attention?.content).toContain('工作尚未开始')
    expect(attention?.content).toContain('团队配置发生变化时自动重新核对')
    expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(0)
    delegation.revokeOwnerManagementDelegation(f.project.id, grant.id)
  }
})

test('Given 项目范围内员工均不具备可用配置 When 确认方案 Then 说明团队配置阻塞且不建议扩大项目资料范围', () => {
  const f = fixture(), grant = authorize(f)
  try {
    employees.updateAgentEmployee(f.executor.id, { enabled: false })
    employees.updateAgentEmployee(f.reviewer!.id, { enabled: false })
    confirm(f)
    reconcileOwnerManagement(f.project.id)
    const attention = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'attention')
    expect(attention?.content).toContain('还没有派工')
    expect(attention?.content).toContain('工作尚未开始')
    expect(attention?.content).toContain('我暂时找不到可承担这项工作的合格团队')
    expect(attention?.content).not.toContain('扩大项目资料范围也不能解决当前团队配置问题')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 待审方案缺少独立评审 When Owner尝试准备团队 Then 不声称范围已确认并说明下一步', async () => {
  const f = fixture('missing-reviewer', false, false), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention'))
    const attention = getOwnerManagementConversation(f.project.id).messages.find(item => item.kind === 'attention')
    expect(plans.getProjectOwnerPlanDraft(f.project.id)?.state).toBe('proposed')
    expect(attention?.content).toContain('方案仍待你确认')
    expect(attention?.content).toContain('还没有派工')
    expect(attention?.content).toContain('团队配置发生变化时自动重新核对')
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 已确认方案因缺评审受阻 When 新建合格员工 Then 持久团队事件自动恢复安排且重复变化不重复请求', async () => {
  const f = fixture('missing-reviewer'), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    confirm(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention' && item.content.includes('还没有派工')))
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
    const reviewer = employees.createAgentEmployee({ name: '独立检查', role: '交付检查', roleTemplateId: 'delivery-verifier', description: '检查成果与标准', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: employees.getAgentEmployee(f.executor.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    expect(reviewer.enabled).toBe(true)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
    employees.updateAgentEmployee(reviewer.id, { description: '继续独立检查成果与标准' })
    await until(() => getOwnerManagementView(f.project.id).pendingEvents === 0)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); stop() }
}, 30_000)

test('Given Owner暂停时团队能力变化 When恢复管理循环 Then累积事件自动重评且只建立一次安排', async () => {
  const f = fixture('missing-reviewer'), grant = authorize(f), stop = startOwnerManagementLoop()
  try {
    confirm(f)
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'attention' && item.content.includes('还没有派工')))
    const manager = getOwnerManager(f.project.id)!
    setOwnerManagerStatus(f.project.id, manager.revision, 'paused')
    employees.createAgentEmployee({ name: '独立检查', role: '交付检查', roleTemplateId: 'delivery-verifier', description: '检查成果与标准', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: employees.getAgentEmployee(f.executor.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
    reconcileOwnerManagement(f.project.id)
    expect(getOwnerManagementView(f.project.id).pendingEvents).toBeGreaterThan(0)
    const paused = getOwnerManager(f.project.id)!
    setOwnerManagerStatus(f.project.id, paused.revision, 'active')
    await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged'))
    await until(() => getOwnerManagementView(f.project.id).pendingEvents === 0)
    expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(1)
    expect(calls.filter(item => item.projectId === f.project.id)).toHaveLength(1)
  } finally { delegation.revokeOwnerManagementDelegation(f.project.id, grant.id); stop() }
}, 20_000)

test('Given 员工新增与团队事件同事务 When 外层写入回滚 Then 员工和唤醒事件一并回滚', () => {
  const f = fixture(), database = store.getProjectDb()
  const employeeCount = employees.listAgentEmployees().length
  const eventCount = database.prepare('SELECT COUNT(*) AS n FROM project_owner_management_events WHERE project_id = ?').get(f.project.id) as { n: number }
  expect(() => database.transaction(() => {
    employees.createAgentEmployee({ name: '回滚员工', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: employees.getAgentEmployee(f.executor.id)!.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
    throw new Error('回滚员工与团队事件')
  })()).toThrow('回滚员工与团队事件')
  const nextEventCount = database.prepare('SELECT COUNT(*) AS n FROM project_owner_management_events WHERE project_id = ?').get(f.project.id) as { n: number }
  expect(employees.listAgentEmployees()).toHaveLength(employeeCount)
  expect(nextEventCount.n).toBe(eventCount.n)
}, 15_000)

test('Given 确认事务回滚或旧方案来源失效 When 后台处理 Then 不安排旧方案，任务级目标也准确隔离', () => {
  const f = fixture()
  expect(() => store.getProjectDb().transaction(() => { confirm(f); throw new Error('rollback') })()).toThrow('rollback')
  reconcileOwnerManagement(f.project.id)
  expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  confirm(f)
  saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '修改后的目标' })
  reconcileOwnerManagement(f.project.id)
  expect(listOwnerExecutionAssignmentRuns(f.subject)).toHaveLength(0)
  const task = fixture('complete', true); confirm(task); reconcileOwnerManagement(task.project.id)
  expect(listOwnerExecutionAssignmentRuns(task.subject)[0]?.link.targetTaskId).toBe(task.taskId)
  expect(listOwnerExecutionAssignmentRuns({ projectId: task.project.id })).toHaveLength(0)
}, 20_000)


test('Given项目已有general员工且无精确模板 When确认方案 Then后台用既有能力形成安排、不改员工档案或让用户重建', async () => {
  for (const team of ['general', 'missing-role', 'mixed'] as const) {
    const f = fixture(team), grant = authorize(f), stop = startOwnerManagementLoop()
    try {
      const before = employees.listAgentEmployees().filter(item => [f.executor.id, f.reviewer!.id].includes(item.id))
      confirm(f)
      await until(() => getOwnerManagementConversation(f.project.id).messages.some(item => item.kind === 'execution_arranged')).catch(cause => { throw new Error(`${String(cause)}：${JSON.stringify(listOwnerExecutionAssignmentRuns(f.subject).map(run => ({ outcomes: run.outcomes, executions: run.executions })))}`) })
      const result = listOwnerExecutionAssignmentRuns(f.subject)[0]!.outcomes[0]!.assignmentProposal!
      expect(result.assignments).toMatchObject([{ employeeId: f.executor.id, roleKey: 'requirements-analyst' }])
      expect(result.reviewerEmployeeId).toBe(f.reviewer!.id)
      const after = employees.listAgentEmployees().filter(item => [f.executor.id, f.reviewer!.id].includes(item.id))
      expect(after.map(item => ({ id: item.id, profile: item.executionProfile, template: item.roleTemplateId, channel: item.channelId, model: item.modelId }))).toEqual(before.map(item => ({ id: item.id, profile: item.executionProfile, template: item.roleTemplateId, channel: item.channelId, model: item.modelId })))
      expect(delegation.getOwnerManagementDelegation(f.project.id).usedRequests).toBe(1)
    } finally { stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
  }
}, 30_000)

test('Given历史完整安排仅因空代码范围被拒绝 When本地恢复并对账 Then保留原失败和费用且不新增安排请求', async () => {
  const f = fixture()
  confirm(f)
  const grant = authorize(f, true), before = calls.length
  legacyNullScopeProjectId = f.project.id
  const stop = startOwnerManagementLoop()
  try {
    await until(() => (store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_planning_run_recoveries r JOIN agent_executions e ON e.id=r.execution_id WHERE e.project_id=?').get(f.project.id) as { n: number }).n === 1)
    const row = store.getProjectDb().prepare('SELECT o.execution_id, o.payload FROM project_owner_planning_run_outcomes o JOIN project_owner_planning_run_recoveries r ON r.execution_id=o.execution_id JOIN agent_executions e ON e.id=o.execution_id WHERE e.project_id=?').get(f.project.id) as { execution_id: string; payload: string }
    expect(JSON.parse(row.payload)).toMatchObject({ state: 'failed', detail: '受控非研发安排不得包含代码范围' })
    const runService = await import('./project-owner-planning-run-service')
    expect(runService.getOwnerPlanningRunOutcome(row.execution_id)).toMatchObject({ state: 'proposed', assignmentProposal: { executionKind: 'controlled' } })
    expect(runService.getOwnerPlanningRunReceipt(JSON.parse(row.payload).receiptId)?.cost).toEqual({ source: 'unknown', usd: null })
    reconcileOwnerManagement(f.project.id)
    reconcileOwnerManagement(f.project.id)
    expect(calls.slice(before).filter(item => item.projectId === f.project.id && item.purpose === 'owner_execution_assignment')).toHaveLength(1)
    expect(store.getAgentExecution(row.execution_id)?.status).toBe('failed')
    expect((store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_management_events WHERE project_id=? AND json_extract(payload,'$.kind')='assignment_result' AND json_extract(payload,'$.sourceId')=?").get(f.project.id, row.execution_id) as { n: number }).n).toBe(2)
  } finally { legacyNullScopeProjectId = null; stop(); delegation.revokeOwnerManagementDelegation(f.project.id, grant.id) }
}, 15_000)

test('Given 失败详情含凭据或换行 When 生成用户原因 Then 脱敏截断且保留可核对信息', async () => {
  const { ownerAssignmentFailureReason } = await import('./project-owner-management-assignment')
  expect(ownerAssignmentFailureReason('Owner人员安排提案格式无效或夹带未授权字段')).toBe('Owner人员安排提案格式无效或夹带未授权字段')
  expect(ownerAssignmentFailureReason('bad Bearer abc123\napi_key=sk-secret123456789')).not.toContain('abc123')
  expect(ownerAssignmentFailureReason('x'.repeat(400)).length).toBe(240)
})

test('Given 结构不合规的失败 When 判断可恢复 Then 允许在原预算内重排一次', async () => {
  const { isRecoverableOwnerAssignmentRejection } = await import('./project-owner-management-assignment')
  expect(isRecoverableOwnerAssignmentRejection('Owner人员安排提案格式无效或夹带未授权字段')).toBe(true)
  expect(isRecoverableOwnerAssignmentRejection('Owner人员安排缺少工作区')).toBe(false)
})

test('Given 已有批次的方案来自无法重建提示词的历史规划 When 再次启动同一方案 Then 保留原批次并说明重复任务阻断', async () => {
  const f = fixture('complete', false, false)
  const issued = authorize(f, true)
  const stop = startOwnerManagementLoop()
  try {
    await until(() => Boolean(store.getProjectDb().prepare("SELECT 1 FROM project_owner_execution_start_intents WHERE project_id=? AND state='completed'").get(f.project.id)))
    await stop()
    const db = store.getProjectDb()
    const plan = plans.getProjectOwnerPlanDraft(f.project.id)!
    const { getOwnerExecutionPreparation } = await import('./project-owner-execution-preparation')
    const prep = getOwnerExecutionPreparation(f.subject).preparation!
    const link = db.prepare('SELECT id,payload FROM project_owner_planning_links WHERE planning_task_id=(SELECT json_extract(payload,\'$.planningTaskId\') FROM project_owner_planning_run_receipts WHERE id=?)').get(plan.sourceRun!.receiptId) as { id: string; payload: string }
    const value = JSON.parse(link.payload) as { promptHash: string }
    value.promptHash = 'f'.repeat(64)
    db.prepare('UPDATE project_owner_planning_links SET payload=? WHERE id=?').run(JSON.stringify(value), link.id)
    const { saveOwnerExecutionStartIntent, resumeOwnerExecutionStartIntent } = await import('./project-owner-execution-start-intent')
    const id = randomUUID()
    const intent = saveOwnerExecutionStartIntent({ ...f.subject, intentId: id, expectedGoalRevision: plan.goalRevision, expectedPlanRevision: plan.revision,
      planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input: { ...prep.input, requestId: id } })
    const count = (db.prepare('SELECT COUNT(*) AS count FROM project_owner_task_materializations WHERE project_id=?').get(f.project.id) as { count: number }).count
    await expect(resumeOwnerExecutionStartIntent(intent.intentId, undefined, { launch: async () => { throw new Error('不应派发') } })).rejects.toThrow('这个方案已有一批任务')
    expect((db.prepare('SELECT COUNT(*) AS count FROM project_owner_task_materializations WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(count)
  } finally { await stop(); delegation.revokeOwnerManagementDelegation(f.project.id, issued.id) }
}, 15000)
