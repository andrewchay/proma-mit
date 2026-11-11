import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { createStore } from 'jotai'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { OwnerExecutionPreparationInput, ProjectOwnerExecutionLaunchApi, ProjectOwnerPlanDraft } from '@gravitas/shared'
import type { OwnerQualityAction } from './project-owner-quality-actions'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'
const directory = mkdtempSync(join(tmpdir(), 'owner-quality-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store'), employees = await import('./agent-employee-service')
const workspaces = await import('./agent-workspace-manager'), channels = await import('./channel-manager')
const goals = await import('./project-owner-goal-service'), plans = await import('./project-owner-plan-service')
const binding = await import('./project-owner-runtime-binding'), prep = await import('./project-owner-execution-preparation')
const material = await import('./project-owner-task-materialization'), delegation = await import('./project-owner-management-delegation')
const management = await import('./project-owner-management-loop'), source = await import('./project-owner-planning-source')
const actions = await import('./project-owner-quality-actions'), scheduler = await import('./project-owner-autonomous-scheduler')
const runs = await import('./project-owner-planning-run-service')
const boundary = await import('./controlled-provider-boundary'), registry = await import('./agent-headless-runner-registry')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { onOwnerAutonomousScheduleWake } = await import('./project-owner-autonomous-scheduler-events')
const executionLaunch = await import('./project-owner-execution-launch')
const executionGrants = await import('./project-owner-execution-grant-issue')
const { registerProjectOwnerExecutionIpcHandlers } = await import('./project-owner-execution-ipc')
const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
const managementConversation = await import('./project-owner-management-questions')
const rendererDeliveryFlow = await import('../../renderer/atoms/owner-delivery-flow-atoms')
const rendererExecution = await import('../../renderer/atoms/project-owner-execution-atoms')
const rendererPlan = await import('../../renderer/atoms/project-owner-plan-atoms')
const rendererGoal = await import('../../renderer/atoms/project-owner-goal-atoms')
const ipcHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
registerProjectOwnerExecutionIpcHandlers({ handle: (channel, handler) => { ipcHandlers.set(channel, handler) } })
interface Scenario { answerBlockedQuestion?: boolean; escalate?: boolean; blockedContinuation?: boolean; fencedReview?: boolean; missingReviewQuote?: 'verbatim' | 'paraphrase'; invalidReviewQuote?: boolean; queueOnly?: boolean; extraQualityCriteria?: boolean; omitQualityKind?: boolean; invalidQualityQuote?: boolean; rework?: boolean; evidenceGap?: boolean; ownerDefect?: boolean; dependent?: boolean; hold?: boolean; maxRework?: number; legacy?: boolean; development?: boolean; nestedCode?: boolean; mixedDelivery?: boolean; separateRoles?: boolean; forkedCode?: boolean; checkInherited?: boolean; browserValidation?: boolean; validationFails?: boolean; durableStartIntent?: boolean; emptyReview?: boolean; localConfigurationError?: string; localConfigurationRuntimeResult?: boolean; localConfigurationNonZeroUsage?: boolean }
interface Trace { role: string; taskId: string; round: number; prompt: string }
const scenarios = new Map<string, Scenario>(), traces = new Map<string, Trace[]>()
const pending = new Map<string, { finish: () => void; executionId: string }>()
beforeAll(async () => {
  await store.initProjectDb()
  registry.setHeadlessAgentRunner(async (input, callbacks) => {
    callbacks.onRuntimeStarted?.()
    const execution = store.getAgentExecutionBySessionId(input.sessionId)!, scenario = scenarios.get(execution.projectId)!
    const log = traces.get(execution.projectId)!
    if (scenario.localConfigurationError) {
      if (scenario.localConfigurationRuntimeResult) {
        const inputTokens = scenario.localConfigurationNonZeroUsage ? 1 : 0
        callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'error_during_execution', session_id: execution.sessionId, result: '', finish_reason: 'error', errors: [scenario.localConfigurationError], usage: { input_tokens: inputTokens, output_tokens: 0 }, owner_planning_usage: { inputTokens: scenario.localConfigurationNonZeroUsage ? 1 : null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } } })
        return
      }
      throw new Error(scenario.localConfigurationError)
    }
    if (execution.ownerCommandId) {
      const command = store.getProjectDb().prepare('SELECT role,rework_ordinal FROM project_owner_execution_commands WHERE id=?').get(execution.ownerCommandId) as { role: string; rework_ordinal: number }
      const runtime = await import('./project-owner-employee-runtime')
      const frozen = runtime.readOwnerCommandFrozenSource(execution.ownerCommandId)
      const development = runtime.ownerTaskDeliveryKind(frozen.source, frozen.taskId) === 'development'
      log.push({ role: command.role, taskId: execution.entityId, round: command.rework_ordinal, prompt: input.userMessage })
      const workspace = workspaces.getAgentWorkspace(store.getTask(execution.entityId)!.workspaceId!)!
      if (development && command.role === 'executor' && command.rework_ordinal > 0) expect(readFileSync(join(workspaces.getAgentWorkspaceCwd(workspace,input.sessionId),'src/solution.cjs'),'utf8')).toContain('answer: 42')
      if (scenario.checkInherited && development && command.role === 'executor' && log.filter(item => item.role === 'executor').length > 1) expect(readFileSync(join(workspaces.getAgentWorkspaceCwd(workspace,input.sessionId),'src/solution.cjs'),'utf8')).toContain('answer: 42')
      if (scenario.forkedCode && command.role === 'executor') {
        const cwd = workspaces.getAgentWorkspaceCwd(workspace, input.sessionId), title = store.getTask(execution.entityId)!.title
        if (title === '分支甲') writeFileSync(join(cwd, 'src/branch-a.cjs'), '甲成果\n')
        if (title === '分支乙') writeFileSync(join(cwd, 'src/branch-b.cjs'), '乙成果\n')
        if (title === '合并实现') {
          expect(readFileSync(join(cwd, 'src/branch-a.cjs'), 'utf8')).toBe('甲成果\n')
          expect(readFileSync(join(cwd, 'src/branch-b.cjs'), 'utf8')).toBe('乙成果\n')
        }
      }
      if (development && command.role === 'executor') writeFileSync(join(workspaces.getAgentWorkspaceCwd(workspace, input.sessionId), 'src/solution.cjs'), `module.exports = { answer: ${scenario.validationFails ? 0 : 42} }\n`)
      if (scenario.browserValidation && command.role === 'executor') writeFileSync(join(workspaces.getAgentWorkspaceCwd(workspace, input.sessionId), 'src/index.html'), '<!doctype html><html><body><h1>已交付页面</h1></body></html>')
      const transport = Object.assign(async () => new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }), { headers: { 'content-type': 'application/json' } }), { preconnect: () => {} }) as typeof globalThis.fetch
      const fetch = boundary.createControlledProviderFetch(input.sessionId, () => ({ runtime: 'ai-sdk', cwd: workspaces.getAgentWorkspaceCwd(workspace, input.sessionId), modelId: input.modelId!, permissionMode: 'safe' }), transport)
      await fetch('https://example.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: input.modelId, max_tokens: 100, messages: [{ role: 'user', content: input.userMessage }] }) })
      if (scenario.nestedCode && command.role === 'executor') {
        const cwd = workspaces.getAgentWorkspaceCwd(workspace, input.sessionId)
        const { bindTestToolContext } = await import('./testing/bound-tool-context')
        const { executeWriteTool } = await import('./agent-runtime/tool-impls/write-tool')
        const result = await executeWriteTool({ file_path: 'diary/index.html', content: '<!doctype html><html><body>日记</body></html>' }, bindTestToolContext({ cwd, sessionId: input.sessionId, ownerWorkspaceWrite: true }))
        expect(result.isError).not.toBe(true)
        expect(readFileSync(join(cwd, 'diary/index.html'), 'utf8')).toContain('日记')
      }
      if (scenario.mixedDelivery) {
        const names = (await import('./project-owner-execution-gates')).getOwnerExecutionToolNames(input.sessionId)
        expect(names?.has('Write')).toBe(development)
        expect(names?.has('Edit')).toBe(development)
      }
      let content = command.rework_ordinal || !scenario.rework ? '目标范围：面向已访谈的现有用户，建议有据可查。' : '目标范围：面向用户，尚未说明受众依据。'
      if (scenario.invalidReviewQuote) content = '目标范围：面向"已访谈"的现有用户，建议有据可查。'
      if (command.role === 'reviewer') {
        if (development) {
          const artifact = (await import('./project-owner-development-artifact')).ownerDevelopmentArtifactFromPrompt(input.userMessage)!
          content = JSON.stringify({ schemaVersion: 3, artifactHash: artifact.contentHash, verdict: scenario.evidenceGap ? 'blocked' : 'approved', summary: scenario.evidenceGap ? '缺少运行验证。' : '代码快照及成功验证符合范围。', criteria: [{ criterion: '代码输出固定42', status: scenario.evidenceGap ? 'not_verified' : 'met', evidence: scenario.evidenceGap ? '缺少运行验证' : '冻结快照包含实现，白名单验证成功', quote: scenario.evidenceGap ? null : scenario.validationFails ? 'answer: 0' : 'answer: 42' }], findings: [], blockerReason: scenario.evidenceGap ? '缺少运行验证' : null })
        } else {
          const artifact = (await import('./project-owner-text-delivery')).assertOwnerReviewerTextDelivery(execution.ownerCommandId)!
          const change = scenario.rework && !scenario.ownerDefect && command.rework_ordinal === 0
          content = JSON.stringify({ schemaVersion: 2, artifactHash: artifact.contentSha256, verdict: change ? 'changes_requested' : 'approved', summary: change ? '缺少受众依据' : '范围清楚', criteria: [{ criterion: '明确目标范围与受众依据', status: change ? 'not_met' : 'met', evidence: change ? '未说明受众依据' : '有明确范围', quote: change ? null : artifact.content }], findings: change ? [{ severity: 'high', description: '未说明受众依据', requestedChange: '补充依据与适用范围' }] : [], blockerReason: null })
        }
      }
      if (scenario.missingReviewQuote && command.role === 'reviewer') {
        const receipt = JSON.parse(content) as { criteria: Array<{ quote?: string; evidence: string }> }
        for (const criterion of receipt.criteria) {
          if (scenario.missingReviewQuote === 'verbatim' && criterion.quote) criterion.evidence = criterion.quote
          delete criterion.quote
        }
        content = JSON.stringify(receipt)
      }
      if (scenario.invalidReviewQuote && command.role === 'reviewer') {
        const receipt = JSON.parse(content) as { criteria: Array<{ quote: string }> }
        receipt.criteria[0]!.quote = '不存在的原文'
        content = JSON.stringify(receipt)
      }
      if (scenario.fencedReview && command.role === 'reviewer') content = '```json\n' + content + '\n```'
      callbacks.onComplete(scenario.emptyReview && command.role === 'reviewer' ? [] : [{ id: randomUUID(), role: 'assistant', content, createdAt: Date.now() }])
      return
    }
    const current = source.resolveOwnerPlanningSession(input.sessionId)!, conversation = current.context.conversation!
    claimOwnerPlanningProviderRequest(input.sessionId, JSON.stringify({ model: current.binding.modelId, stream: true, max_tokens: current.link.maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: current.request.systemPrompt }, { role: 'user', content: current.request.userPrompt }] }), new URL('https://example.invalid/v1/chat/completions'))
    if (current.link.purpose === 'owner_execution_assignment') {
      const context = current.assignmentContext!
      const reviewers = context.candidates.filter(item => item.id !== context.candidates[0]?.id)
      const reviewer = reviewers.find(item => ['reviewer', 'delivery-verifier'].includes(item.roleTemplateId ?? '')) ?? reviewers[0]
      if (!reviewer) throw new Error('反馈续做场景缺少独立评审候选')
      const assignments = [...new Set(context.steps.map(step => step.roleKey))].map(roleKey => ({
        roleKey,
        employeeId: context.candidates.find(item => item.id !== reviewer.id && (item.roleTemplateId === roleKey || item.roleTemplateId === undefined))!.id,
        reason: '符合当前岗位能力与项目范围',
      }))
      const response = { schemaVersion: 1, contextFingerprint: context.contextFingerprint, selectedStepKeys: context.steps.map(step => step.key), scopeReason: '按已确认目标继续修订成果', workspaceId: context.workspaces[0]!.id, workspaceReason: '沿用本项目授权资料空间', executionKind: 'controlled', executionKindReason: '使用当前非代码交付方式', assignments, reviewerEmployeeId: reviewer.id, reviewerReason: '独立检查修订后的成果' }
      log.push({ role: 'owner_arrangement', taskId: execution.entityId, round: 0, prompt: current.request.userPrompt })
      callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify(response), owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, usage: { input_tokens: 10, output_tokens: 20 } } })
      return
    }
    const delivery = conversation.deliveryReview
    if (conversation.deliveryFeedback || ((scenario.escalate || scenario.blockedContinuation) && !conversation.executionObservation)) {
      const feedback = conversation.deliveryFeedback
      const roleKey = current.context.sources.roles[0]!.key
      const response = { schemaVersion: 1, kind: 'plan_proposal', binding: { projectId: execution.projectId, goalVersion: current.context.goal.goal.goalVersion, contextFingerprint: current.context.fingerprint }, proposal: {
        summary: '在原交付基础上补充用户指定的目标用户分析，并保留原有结论依据', assumptions: [], risks: [],
        steps: [{ key: 'revise-delivery', title: '按反馈修订定位建议', outcome: '交付补充目标用户分析的新版建议', acceptanceCriteria: feedback?.acceptanceCriteria ?? ['明确目标范围与受众依据'], dependencies: [], roleKey }],
        ...(feedback ? { deliveryFeedbackAssessment: { messageId: feedback.messageId, artifactHash: feedback.artifactHash, ...(feedback.stepKey ? { stepKey: feedback.stepKey } : {}), summary: '本次修改针对已验收成果的目标用户分析补充', changes: feedback.acceptanceCriteria.map(criterion => ({ criterion, disposition: 'addressed', proposedChange: '在新版中补充对应分析并保留可核对依据' })), authorizationImpact: 'within_confirmed_boundary', authorizationRationale: '修改仍在原目标和交付边界内；旧执行许可不会沿用，需确认本次方案后再执行' } } : {}),
      } }
      log.push({ role: 'owner_feedback', taskId: current.context.conversation?.tasks[0]?.id ?? '', round: 0, prompt: current.request.userPrompt })
      callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify(response), owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, usage: { input_tokens: 10, output_tokens: 20 } } })
      return
    }
    if (scenario.answerBlockedQuestion && !conversation.executionObservation) {
      const response = { schemaVersion: 1, kind: 'conversation_reply', binding: { projectId: execution.projectId, goalVersion: current.context.goal.goal.goalVersion, contextFingerprint: current.context.fingerprint }, messageId: conversation.throughMessageId, message: '原质量决定仍被阻断，请先核对返工额度。' }
      callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify(response), owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, usage: { input_tokens: 10, output_tokens: 20 } } })
      return
    }
    const observed = conversation.executionObservation!
    const artifactHash = delivery?.developmentArtifact?.contentHash ?? delivery?.artifact?.contentSha256
    const artifactContent = delivery?.developmentArtifact?.content ?? delivery?.artifact?.content
    const artifactRound = delivery?.developmentArtifact?.reworkOrdinal ?? delivery?.artifact?.reworkOrdinal ?? 0
    log.push({ role: delivery?.qualityDecisionVersion ? 'owner_quality' : 'owner_analysis', taskId: observed.businessTaskId, round: artifactRound, prompt: current.request.userPrompt })
    const responseBinding = { projectId: execution.projectId, goalVersion: current.context.goal.goal.goalVersion, contextFingerprint: current.context.fingerprint }
    const defect = Boolean(scenario.rework && artifactRound === 0)
    const decision = { reviewerCommandId: observed.commandId, artifactHash, verdict: scenario.escalate && !log.some(item => item.role === 'owner_feedback') ? 'escalate' : defect ? 'rework' : 'accept', reason: defect ? '受众依据仍缺，不能只看格式通过' : '已按准确范围标准核对完整成果与独立检查', criteria: [{ criterion: delivery?.developmentArtifact ? '代码输出固定42' : '明确目标范围与受众依据', status: defect ? 'not_met' : 'met', evidence: defect ? '正文未说明受众依据' : '范围与依据对应', quote: (scenario.invalidQualityQuote ? 'var bestKey = \'best-score-2048\';' : delivery?.developmentArtifact ? 'answer: 42' : artifactContent) as string | null | undefined }], findings: defect ? [{ severity: 'high', description: '受众依据未交代', requestedChange: '补充受众依据并保留明确范围' }] : [] }
    if (scenario.evidenceGap) {
      decision.verdict = 'rework'
      decision.criteria[0] = { criterion: '代码输出固定42', status: 'not_verified', evidence: '缺少运行验证', quote: null }
      decision.findings = [{ severity: 'medium', description: '验证证据不足', requestedChange: '补充运行验证' }]
    }
    if (scenario.extraQualityCriteria && delivery?.qualityDecisionVersion === 1) decision.criteria.push({ criterion: '明确范围', status: 'met', evidence: '额外已满足项目标准', quote: artifactContent })
    const response = delivery?.qualityDecisionVersion === 1 ? { schemaVersion: 1, kind: 'quality_decision', binding: responseBinding, messageId: conversation.throughMessageId, message: '已按完整成果逐项判断，待服务核验决定。', decision } : { schemaVersion: 1, kind: 'conversation_reply', binding: responseBinding, messageId: conversation.throughMessageId, message: '成果已收到，等待独立检查和质量判断。' }
    const { kind: _kind, ...withoutKind } = response
    const finish = () => callbacks.onComplete([], { runtimeResult: { type: 'result', subtype: 'success', session_id: execution.sessionId, finish_reason: 'stop', result: JSON.stringify(scenario.omitQualityKind && delivery?.qualityDecisionVersion === 1 ? withoutKind : response), owner_planning_usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null }, usage: { input_tokens: 10, output_tokens: 20 } } })
    if (scenario.hold && delivery?.qualityDecisionVersion) pending.set(execution.projectId, { finish, executionId: execution.id })
    else finish()
  })
})
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
async function until(predicate: () => boolean, projectId?: string) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const tasks = projectId ? store.listTasks(projectId).filter(item => item.ownerStepLinkId) : []
  const commands = projectId ? store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE project_id=? ORDER BY created_at').all(projectId) : []
  const actions = projectId ? actionRows(projectId).map(action => ({ taskId: action.taskId, state: action.state, detail: action.detail })) : []
  const schedule = projectId ? scheduler.getOwnerAutonomousScheduleStatus(projectId) : null
  throw new Error(`等待Owner质量管理闭环超时：${JSON.stringify({ tasks: tasks.map(item => ({ id: item.id, status: item.status })), commands, actions, schedule,
    management: projectId ? delegation.getOwnerManagementDelegation(projectId) : null,
    failures: projectId ? store.listAgentExecutionsByProject(projectId).filter(item => item.status === 'failed').map(item => item.error) : [] })}`)
}
async function fixture(scenario: Scenario = {}) {
  const repo = scenario.development ? join(directory, `repo-${randomUUID()}`) : undefined
  if (repo) {
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src/solution.cjs'), 'module.exports = { answer: -1 }\n')
    writeFileSync(join(repo, 'src/verify.cjs'), "const { answer } = require('./solution.cjs'); if (answer !== 42) process.exit(1)\n")
    if (scenario.browserValidation) writeFileSync(join(repo, 'src/index.html'), '<!doctype html><html><body>初始页面</body></html>')
    for (const args of [['init'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-m', 'baseline']]) execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }
  const project = store.createProject({ title: '定位建议质量闭环', description: '' }), workspace = workspaces.createAgentWorkspace(`质量-${randomUUID()}`, repo)
  scenarios.set(project.id, scenario); traces.set(project.id, [])
  ;(await import('./project-workspace-bindings')).bindWorkspaceToProject(project.id, workspace.id)
  const channel = channels.createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'fake', enabled: true }] })
  const employee = (name: string, profile: 'general' | 'controlled' | 'development') => employees.createAgentEmployee({ name, role: '定位研究与检查', description: '', executionProfile: profile, permissionMode: profile === 'controlled' ? 'safe' : 'auto', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  const owner = employee('Owner', 'controlled'), executor = employee('已有调研员', scenario.development ? 'development' : 'general'), reviewer = employee('已有独立检查员', scenario.development ? 'development' : 'general')
  const writer = scenario.separateRoles ? employee('文字员工', 'controlled') : undefined
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成定位建议', ...(scenario.extraQualityCriteria ? { acceptanceCriteria: ['明确范围'] } : {}) })
  binding.saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试' })
  const context = plans.getProjectOwnerPlanningContext(project.id), roleKey = context.sources.roles[0]!.key
  const textRoleKey = scenario.separateRoles ? context.sources.roles[1]!.key : roleKey
  const criterion = scenario.development ? '代码输出固定42' : '明确目标范围与受众依据'
  const steps = scenario.forkedCode && scenario.mixedDelivery
    ? [{ key: 'brief', title: '形成建议', outcome: '定位材料', acceptanceCriteria: ['明确目标范围与受众依据'], dependencies: [] as string[], roleKey, deliveryKind: 'text' as const }, { key: 'a', title: '分支甲', outcome: '代码甲', acceptanceCriteria: [criterion], dependencies: ['brief'], roleKey, deliveryKind: 'development' as const }, { key: 'b', title: '分支乙', outcome: '代码乙', acceptanceCriteria: [criterion], dependencies: ['brief'], roleKey, deliveryKind: 'development' as const }, { key: 'merge', title: '合并实现', outcome: '完整代码', acceptanceCriteria: [criterion], dependencies: ['a', 'b'], roleKey, deliveryKind: 'development' as const }]
    : scenario.forkedCode
    ? [{ key: 'a', title: '分支甲', outcome: '代码甲', acceptanceCriteria: [criterion], dependencies: [] as string[], roleKey }, { key: 'b', title: '分支乙', outcome: '代码乙', acceptanceCriteria: [criterion], dependencies: [] as string[], roleKey }, { key: 'merge', title: '合并实现', outcome: '完整代码', acceptanceCriteria: [criterion], dependencies: ['a', 'b'], roleKey }]
    : scenario.mixedDelivery
    ? [{ key: 'brief', title: '形成建议', outcome: '定位材料', acceptanceCriteria: ['明确目标范围与受众依据'], dependencies: [] as string[], roleKey: textRoleKey, deliveryKind: 'text' as const }, { key: 'delivery', title: '修复代码', outcome: '代码实现', acceptanceCriteria: ['代码输出固定42'], dependencies: ['brief'], roleKey, deliveryKind: 'development' as const }]
    : [{ key: 'brief', title: scenario.development ? '修复代码' : '形成建议', outcome: scenario.development ? '代码实现' : '定位材料', acceptanceCriteria: [criterion], dependencies: [] as string[], roleKey }, ...(scenario.dependent ? [{ key: 'delivery', title: '整理最终建议', outcome: '最终版本', acceptanceCriteria: [criterion], dependencies: ['brief'], roleKey }] : [])]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '计划', assumptions: [], risks: [], steps, changeReason: '建立' }); const confirmedPlan = plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const roleAssignments = [{ roleKey, employeeId: executor.id }, ...(writer ? [{ roleKey: textRoleKey, employeeId: writer.id }] : [])].sort((a, b) => a.roleKey.localeCompare(b.roleKey))
  const subject = { projectId: project.id }, input = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(item => item.key), executionKind: scenario.development ? 'development' : 'controlled', ...(!scenario.development ? { textDeliveryVersion: 1 } : { developmentScope: { workspaceId: workspace.id, targetPaths: scenario.nestedCode ? ['src/solution.cjs', 'diary/index.html'] : scenario.browserValidation ? ['src/solution.cjs', 'src/index.html'] : ['src/solution.cjs'], allowedPaths: scenario.nestedCode ? ['src', 'diary/index.html'] : ['src'], verificationCommands: scenario.browserValidation ? ['browser:html.loads'] : ['node src/verify.cjs'] } }), ...(!scenario.legacy ? { qualityManagementVersion: 1 } : {}), employeeRuntimeVersion: 2, executorEmployeeId: roleAssignments[0]!.employeeId, reviewerEmployeeId: reviewer.id, roleAssignments, workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1_000_000, maxRuns: 8, maxRework: scenario.maxRework ?? 1, expiresAt: Date.now() + 3600000, changeReason: '测试质量委托' }
  const pv = prep.previewOwnerExecutionPreparation(subject, input), saved = prep.saveOwnerExecutionPreparation(subject, input, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: saved.id, expectedPreparationRevision: saved.revision, expectedPreparationHash: saved.integrityHash, expectedPolicyRevision: saved.policyRevision }
  const permissionInput = { ...subject, requestId: randomUUID(), maxRequests: 12, maxCostMicros: 15_000_000, ...(scenario.escalate || scenario.blockedContinuation ? { autonomousExecution: true } : {}), expiresAt: Date.now() + 3600000 }, permissionPreview = delegation.previewOwnerManagementDelegation(permissionInput)
  delegation.confirmOwnerManagementDelegation({ input: permissionInput, previewHash: permissionPreview.previewHash })
  const consumeInitialEvents = async () => {
    const managementStore = await import('./project-owner-management-store')
    for (const event of managementStore.listPendingOwnerManagementEvents(project.id)) managementStore.consumeOwnerManagementEvent(event)
  }
  let stopLifecycle = async () => {}
  const startLifecycle = async () => {
    await consumeInitialEvents()
    const stopWake = onOwnerAutonomousScheduleWake(id => { if (id === project.id) void scheduler.runOwnerAutonomousSchedule(id) })
    const stopManagement = management.startOwnerManagementLoop()
    stopLifecycle = async () => { stopWake(); await stopManagement() }
  }
  if (scenario.durableStartIntent) await startLifecycle()
  let grant: Awaited<ReturnType<typeof executionLaunch.launchOwnerPreparedExecution>>
  if (scenario.durableStartIntent) {
    const saveResult = await ipcHandlers.get(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT)!(undefined, { ...subject, intentId: input.requestId, expectedGoalRevision: input.expectedGoalRevision,
      expectedPlanRevision: input.expectedPlanRevision, planFingerprint: confirmedPlan.planFingerprint, contextFingerprint: confirmedPlan.contextFingerprint, input }) as { ok: boolean; error?: { message: string } }
    if (!saveResult.ok) throw new Error(saveResult.error?.message ?? '保存启动意图失败')
    const resumeResult = await ipcHandlers.get(PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT)!(undefined, { ...subject, intentId: input.requestId }) as { ok: boolean; error?: { message: string } }
    if (!resumeResult.ok) throw new Error(resumeResult.error?.message ?? '恢复启动意图失败')
    grant = executionGrants.getOwnerExecutionGrant(subject)!
  } else {
    const preview = material.previewOwnerTaskMaterialization(subject, materialInput)
    grant = await executionLaunch.launchOwnerPreparedExecution({ ...subject, input: materialInput, previewFingerprint: preview.previewFingerprint }, { schedule: async () => {} })
  }
  if (!scenario.durableStartIntent && !scenario.queueOnly) await startLifecycle()
  // 初始目标/计划及边界已确认；本用例仅测交付后管理，不伪造模型或业务授权。
  if (scenario.queueOnly) {
    const { reserveAndQueueAutonomousOwnerCommand } = await import('./project-owner-execution-command')
    let queued: ReturnType<typeof reserveAndQueueAutonomousOwnerCommand>
    await scheduler.runOwnerAutonomousSchedule(project.id, {
      queue: (...args) => (queued = reserveAndQueueAutonomousOwnerCommand(...args)),
      dispatch: async () => ({ ...queued, started: true }),
    })
  } else await scheduler.runOwnerAutonomousSchedule(project.id)
  return { project, grant, input, executor, writer, reviewer, owner, stop: stopLifecycle, tasks: () => store.listTasks(project.id).filter(item => item.ownerStepLinkId) }
}
function actionRows(projectId: string): OwnerQualityAction[] { return (store.getProjectDb().prepare('SELECT owner_execution_id FROM project_owner_quality_actions WHERE project_id=? ORDER BY rowid').all(projectId) as { owner_execution_id: string }[]).map(row => actions.readOwnerQualityActionByExecution(row.owner_execution_id)!) }

async function confirmFeedbackThroughRenderer(projectId: string, planDraft: ProjectOwnerPlanDraft, input: OwnerExecutionPreparationInput) {
  const subject = { projectId }, subjectKey = JSON.stringify([projectId, null]), ui = createStore()
  ui.set(rendererGoal.ownerGoalEditorsAtom, new Map([[subjectKey, { ...rendererGoal.getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goals.getProjectOwnerGoalDraft(projectId)! }]]))
  ui.set(rendererPlan.ownerPlanEditorsAtom, new Map([[subjectKey, { ...rendererPlan.getOwnerPlanEditor(new Map(), subject), loaded: true, snapshot: planDraft, context: plans.getProjectOwnerPlanningContext(projectId) }]]))
  const date = new Date(input.expiresAt), pad = (value: number) => String(value).padStart(2, '0')
  ui.set(rendererExecution.ownerExecutionEditorsAtom, new Map([[subjectKey, {
    ...rendererExecution.getOwnerExecutionEditor(new Map(), subject), loaded: true, view: prep.getOwnerExecutionPreparation(subject), requestId: input.requestId,
    selectedStepKeys: [...input.selectedStepKeys], executionKind: input.executionKind, executorEmployeeId: input.executorEmployeeId,
    reviewerEmployeeId: input.reviewerEmployeeId, roleAssignments: Object.fromEntries((input.roleAssignments ?? []).map(item => [item.roleKey, item.employeeId])),
    workspaceId: input.workspaceId, knowledgeSourceIds: [...input.knowledgeSourceIds], maxCostMicrosText: String(input.maxCostMicros),
    maxRunsText: String(input.maxRuns), maxReworkText: String(input.maxRework), expiresAtText: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`,
    changeReason: input.changeReason,
  }]]))
  const calls: Array<{ action: 'save' | 'resume'; intentId: string }> = []
  ui.set(rendererDeliveryFlow.ownerExecutionLaunchApiAtom, {
    saveOwnerExecutionStartIntent: async request => {
      calls.push({ action: 'save', intentId: request.intentId })
      return await ipcHandlers.get(PROJECT_IPC_CHANNELS.SAVE_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['saveOwnerExecutionStartIntent']>>
    },
    resumeOwnerExecutionStartIntent: async request => {
      calls.push({ action: 'resume', intentId: request.intentId })
      return await ipcHandlers.get(PROJECT_IPC_CHANNELS.RESUME_OWNER_EXECUTION_START_INTENT)!(undefined, request) as Awaited<ReturnType<ProjectOwnerExecutionLaunchApi['resumeOwnerExecutionStartIntent']>>
    },
  })
  await ui.set(rendererDeliveryFlow.reviewOwnerManagedExecutionAtom, subject)
  return calls
}

test('Given独立评审回执包有围栏并遗漏引用字段 When已有逐字依据可核验 Then原文留存且同一次评审进入Owner决定', async () => {
  const f = await fixture({ fencedReview: true, missingReviewQuote: 'verbatim' })
  try {
    await until(() => actionRows(f.project.id).length === 1, f.project.id)
    const action = actionRows(f.project.id)[0]!
    expect(action.state).toBe('accepted')
    const row = store.getProjectDb().prepare('SELECT response_json,original_response_text,original_response_sha256 FROM project_owner_technical_reviews WHERE reviewer_command_id=?').get(action.reviewerCommandId) as { response_json: string; original_response_text: string; original_response_sha256: string }
    expect(row.original_response_text.startsWith('```json')).toBe(true)
    expect(row.original_response_sha256).toBe(createHash('sha256').update(row.original_response_text).digest('hex'))
    expect(JSON.parse(row.response_json).criteria[0].quote).toContain('目标范围')
    expect(traces.get(f.project.id)?.filter(item => item.role === 'reviewer')).toHaveLength(1)
    const view = managementConversation.getOwnerManagementConversation(f.project.id)
    expect(view.reviewHistory?.[0]?.steps.map(step => step.label)).toEqual(['员工交付', '独立评审', 'Owner 决定'])
    expect(view.reviewHistory?.[0]?.steps[2]?.detail).toContain('权威任务状态已完成')
  } finally { await f.stop() }
}, 15000)

test('Given评审遗漏引用且只有概括 When核验回执 Then不补造证据或重派', async () => {
  const f = await fixture({ missingReviewQuote: 'paraphrase' })
  try {
    await until(() => managementConversation.getOwnerManagementConversation(f.project.id).messages.some(message => message.eventId.startsWith('owner-review-evidence-rejected:')), f.project.id)
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(traces.get(f.project.id)?.filter(item => item.role === 'reviewer')).toHaveLength(1)
    expect(managementConversation.getOwnerManagementConversation(f.project.id).reviewHistory?.[0]?.steps[1]?.detail).toContain('待核对')
  } finally { await f.stop() }
}, 15000)

test('Given已结算评审因引号排版被拒 When原会话和终态摘要完整一致 Then恢复原文并保留原记录且不重派', async () => {
  const f = await fixture({ invalidReviewQuote: true })
  try {
    await until(() => managementConversation.getOwnerManagementConversation(f.project.id).messages.some(message => message.eventId.startsWith('owner-review-evidence-rejected:')), f.project.id)
    const db = store.getProjectDb()
    const row = db.prepare("SELECT id,execution_id,grant_id,source_task_id FROM project_owner_execution_commands WHERE project_id=? AND role='reviewer'").get(f.project.id) as { id: string; execution_id: string; grant_id: string; source_task_id: string }
    const execution = store.getAgentExecution(row.execution_id)!
    const artifact = (await import('./project-owner-text-delivery')).assertOwnerReviewerTextDelivery(row.id)!
    const receipt = JSON.parse(execution.resultSummary!) as { criteria: Array<{ quote: string }> }
    receipt.criteria[0]!.quote = artifact.content.replace('"已访谈"', '“已访谈”')
    const raw = JSON.stringify(receipt)
    const path = (await import('./config-paths')).getAgentSessionMessagesPath(execution.sessionId)
    writeFileSync(path, [JSON.stringify({ type: 'assistant', session_id: execution.sessionId, message: { content: [{ type: 'text', text: raw }] } }), JSON.stringify({ type: 'result', subtype: 'success', session_id: execution.sessionId })].join('\n') + '\n')
    const recovery = await import('./project-owner-review-recovery')
    expect(recovery.recoverOwnerReviewTypography(f.project.id, row.grant_id, row.source_task_id, 0)).toBe(false)
    db.prepare('UPDATE agent_executions SET result_summary=? WHERE id=?').run(raw, execution.id)
    await scheduler.runOwnerAutonomousSchedule(f.project.id)
    await until(() => actionRows(f.project.id).length === 1, f.project.id)
    expect(actionRows(f.project.id)[0]?.state).toBe('accepted')
    expect(recovery.recoverOwnerReviewTypography(f.project.id, row.grant_id, row.source_task_id, 0)).toBe(false)
    const stored = db.prepare('SELECT response_json,original_response_text FROM project_owner_technical_reviews WHERE reviewer_command_id=?').get(row.id) as { response_json: string; original_response_text: string }
    expect(stored.original_response_text).toBe(raw)
    expect(JSON.parse(stored.response_json).criteria[0].quote).toBe(artifact.content)
    expect(traces.get(f.project.id)?.filter(item => item.role === 'reviewer')).toHaveLength(1)
    expect(managementConversation.getOwnerManagementConversation(f.project.id).messages.some(message => message.eventId.startsWith('owner-review-evidence-rejected:'))).toBe(true)
  } finally { await f.stop() }
}, 15000)

test('Given研发终态正在冻结成果且会话已失活 When心跳扫描 Then等待终态结算而不误标中断', async () => {
  const artifacts = await import('./project-owner-development-artifact')
  const original = artifacts.freezeOwnerDevelopmentArtifact
  let entered = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const freeze = spyOn(artifacts, 'freezeOwnerDevelopmentArtifact').mockImplementation(async (...args) => {
    entered = true
    await gate
    return original(...args)
  })
  const f = await fixture({ development: true })
  try {
    await until(() => entered, f.project.id)
    const before = store.getProjectDb().prepare("SELECT state,execution_id FROM project_owner_execution_commands WHERE project_id=? AND role='executor'").get(f.project.id) as { state: string; execution_id: string }
    employees.scanAgentEmployeeHeartbeat()
    expect(store.getAgentExecution(before.execution_id)?.status).toBe('running')
    expect((store.getProjectDb().prepare('SELECT state FROM project_owner_execution_commands WHERE execution_id=?').get(before.execution_id) as { state: string }).state).toBe('running')
    release()
    await until(() => actionRows(f.project.id).length === 1, f.project.id)
    expect(actionRows(f.project.id)[0]?.state).toBe('accepted')
  } finally { release(); freeze.mockRestore(); await f.stop() }
}, 15000)

test('Given研发快照冻结后误标失联且全部费用已结算 When只读预览迟到终态 Then保留原账本并拒绝失效证据', async () => {
  const artifacts = await import('./project-owner-development-artifact')
  const original = artifacts.freezeOwnerDevelopmentArtifact
  let entered = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const freeze = spyOn(artifacts, 'freezeOwnerDevelopmentArtifact').mockImplementation(async (...args) => {
    const snapshot = await original(...args)
    entered = true
    await gate
    return snapshot
  })
  const f = await fixture({ development: true })
  try {
    await until(() => entered, f.project.id)
    await f.stop()
    const db = store.getProjectDb()
    const command = db.prepare("SELECT id,execution_id FROM project_owner_execution_commands WHERE project_id=? AND role='executor'").get(f.project.id) as { id: string; execution_id: string }
    const execution = store.getAgentExecution(command.execution_id)!
    const stop = await import('./project-owner-execution-stop')
    expect(stop.recoverInterruptedOwnerRuntimeExecutions(Date.now(), execution.id)).toHaveLength(1)
    const preview = (await import('./project-owner-late-completion-preview')).previewOwnerLateCompletion
    expect(await preview(command.id, () => false)).toBeNull()
    release()
    await until(() => !employees.isOwnerCommandFinalizing(command.id), f.project.id)
    const path = (await import('./config-paths')).getAgentSessionMessagesPath(execution.sessionId)
    writeFileSync(path, [JSON.stringify({ type: 'assistant', session_id: execution.sessionId, message: { content: [{ type: 'text', text: '完成代码' }] } }), JSON.stringify({ type: 'result', subtype: 'success', finish_reason: 'stop', session_id: execution.sessionId,
      usage: { input_tokens: 10, output_tokens: 5 }, toolCallBatchIntegrity: { version: 1, complete: true, reasons: [], unexecutedMandatory: false } })].join('\n') + '\n')
    const reconcile = (await import('./project-owner-late-completion-reconcile')).reconcileOwnerLateCompletion
    const before = db.prepare('SELECT state,actual_cost_micros,usage_evidence,usage_record_key FROM project_owner_execution_commands WHERE id=?').get(command.id)
    const ready = await preview(command.id, () => false)
    expect(ready).not.toBeNull()
    expect(await preview(command.id, () => true)).toBeNull()
    const request = db.prepare('SELECT request_id,settled_cost_micros FROM project_owner_execution_request_reservations WHERE command_id=?').get(command.id) as { request_id: string; settled_cost_micros: number }
    db.prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile',settled_cost_micros=NULL WHERE request_id=?").run(request.request_id)
    expect(await preview(command.id, () => false)).toBeNull()
    db.prepare("UPDATE project_owner_execution_request_reservations SET state='settled',settled_cost_micros=? WHERE request_id=?").run(request.settled_cost_micros, request.request_id)
    let activeChecks = 0
    expect(await preview(command.id, () => {
      if (++activeChecks === 2) db.prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile',settled_cost_micros=NULL WHERE request_id=?").run(request.request_id)
      return false
    })).toBeNull()
    db.prepare("UPDATE project_owner_execution_request_reservations SET state='settled',settled_cost_micros=? WHERE request_id=?").run(request.settled_cost_micros, request.request_id)
    db.prepare('UPDATE project_owner_execution_start_receipts SET received_at=received_at+1 WHERE command_id=?').run(command.id)
    await expect(reconcile(command.id, ready!.fingerprint, () => false)).rejects.toThrow()
    db.prepare('UPDATE project_owner_execution_start_receipts SET received_at=received_at-1 WHERE command_id=?').run(command.id)
    const meta = (await import('./agent-session-manager')).getAgentSessionMeta(execution.sessionId)!
    const workspace = workspaces.getAgentWorkspace(meta.workspaceId!)!
    const file = join(workspaces.getAgentWorkspaceCwd(workspace, execution.sessionId), 'src/solution.cjs')
    const originalContent = readFileSync(file, 'utf8')
    writeFileSync(file, `${originalContent}\n// 变更后的源码\n`)
    expect(await preview(command.id, () => false)).toBeNull()
    await expect(reconcile(command.id, ready!.fingerprint, () => false)).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_late_completion_reconciliations WHERE command_id=?').get(command.id)).toEqual({ count: 0 })
    writeFileSync(file, originalContent)
    expect(db.prepare('SELECT state,actual_cost_micros,usage_evidence,usage_record_key FROM project_owner_execution_commands WHERE id=?').get(command.id)).toEqual(before)
    db.exec("CREATE TRIGGER late_completion_test_failure BEFORE UPDATE OF status ON agent_executions WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, '模拟事务失败'); END")
    await expect(reconcile(command.id, ready!.fingerprint, () => false)).rejects.toThrow('模拟事务失败')
    db.exec('DROP TRIGGER late_completion_test_failure')
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_late_completion_reconciliations WHERE command_id=?').get(command.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT state,actual_cost_micros,usage_evidence,usage_record_key FROM project_owner_execution_commands WHERE id=?').get(command.id)).toEqual(before)
    const outcome = await reconcile(command.id, ready!.fingerprint, () => false)
    expect(outcome.originalCommand).toMatchObject({ state: 'needs_reconcile', actualCostMicros: null })
    expect(outcome.originalExecution.status).toBe('stale')
    expect(store.getAgentExecution(execution.id)?.status).toBe('completed')
    expect(db.prepare('SELECT state,actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(command.id)).toMatchObject({ state: 'settled', actual_cost_micros: outcome.costMicros })
    expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(outcome.grantId)).toEqual({ state: 'paused' })
    const audit = db.prepare('SELECT payload,integrity_hash FROM project_owner_late_completion_reconciliations WHERE command_id=?').get(command.id) as { payload: string; integrity_hash: string }
    expect(JSON.parse(audit.payload)).toEqual(outcome)
    expect(audit.integrity_hash).toBe((await import('./project-owner-execution-hash')).ownerExecutionHash(outcome))
    await expect(reconcile(command.id, ready!.fingerprint, () => false)).rejects.toThrow()
    expect(() => db.prepare('UPDATE project_owner_late_completion_reconciliations SET payload=? WHERE command_id=?').run('{}', command.id)).toThrow()
    const resume = (await import('./project-owner-late-completion-resume')).resumeOwnerLateCompletion
    await expect(resume(command.id, () => true)).rejects.toThrow()
    expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(outcome.grantId)).toEqual({ state: 'paused' })
    writeFileSync(file, `${originalContent}\n// 恢复期间再次修改\n`)
    await expect(resume(command.id, () => false)).rejects.toThrow()
    expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(outcome.grantId)).toEqual({ state: 'paused' })
    writeFileSync(file, originalContent)
    const validation = await import('./development-validation-service')
    const failure = spyOn(validation, 'runOwnerDevelopmentValidations').mockRejectedValueOnce(new Error('模拟验证中断'))
    await expect(resume(command.id, () => false)).rejects.toThrow('模拟验证中断')
    failure.mockRestore()
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_late_completion_resumptions WHERE command_id=?').get(command.id)).toEqual({ count: 0 })
    expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(outcome.grantId)).toEqual({ state: 'paused' })
    await resume(command.id, () => false)
    expect(db.prepare('SELECT state FROM project_owner_execution_grants WHERE id=?').get(outcome.grantId)).toEqual({ state: 'active' })
    const resumed = db.prepare('SELECT payload FROM project_owner_late_completion_resumptions WHERE command_id=?').get(command.id) as { payload: string }
    expect(JSON.parse(resumed.payload).validations).toHaveLength(1)
    await resume(command.id, () => false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_late_completion_resumptions WHERE command_id=?').get(command.id)).toEqual({ count: 1 })
  } finally { release(); freeze.mockRestore(); await f.stop() }
}, 15000)

test('Given可信迟到终态与完整结算 When自主调度恢复 Then验证后续派独立评审且不重跑执行员工', async () => {
  const artifacts = await import('./project-owner-development-artifact'), original = artifacts.freezeOwnerDevelopmentArtifact
  let entered = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const freeze = spyOn(artifacts, 'freezeOwnerDevelopmentArtifact').mockImplementation(async (...args) => {
    const snapshot = await original(...args); entered = true; await gate; return snapshot
  })
  const f = await fixture({ development: true })
  try {
    await until(() => entered, f.project.id)
    await f.stop()
    const db = store.getProjectDb(), command = db.prepare("SELECT id,execution_id FROM project_owner_execution_commands WHERE project_id=? AND role='executor'").get(f.project.id) as { id: string; execution_id: string }
    const execution = store.getAgentExecution(command.execution_id)!
    ;(await import('./project-owner-execution-stop')).recoverInterruptedOwnerRuntimeExecutions(Date.now(), execution.id)
    release(); await until(() => !employees.isOwnerCommandFinalizing(command.id), f.project.id)
    const path = (await import('./config-paths')).getAgentSessionMessagesPath(execution.sessionId)
    writeFileSync(path, [JSON.stringify({ type: 'assistant', session_id: execution.sessionId, message: { content: [{ type: 'text', text: '完成代码' }] } }), JSON.stringify({ type: 'result', subtype: 'success', finish_reason: 'stop', session_id: execution.sessionId,
      usage: { input_tokens: 10, output_tokens: 5 }, toolCallBatchIntegrity: { version: 1, complete: true, reasons: [], unexecutedMandatory: false } })].join('\n') + '\n')
    const reserve = (await import('./project-owner-execution-command')).reserveAndQueueAutonomousOwnerCommand
    let queued: ReturnType<typeof reserve> | undefined
    await scheduler.runOwnerAutonomousSchedule(f.project.id, { queue: (...args) => (queued = reserve(...args)), dispatch: async () => ({ ...queued!, started: true }) })
    expect(db.prepare('SELECT state,actual_cost_micros FROM project_owner_execution_commands WHERE id=?').get(command.id)).toMatchObject({ state: 'settled' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_late_completion_resumptions WHERE command_id=?').get(command.id)).toEqual({ count: 1 })
    expect(db.prepare("SELECT role,state FROM project_owner_execution_commands WHERE project_id=? AND role='reviewer'").get(f.project.id)).toMatchObject({ role: 'reviewer', state: 'queued' })
    expect(traces.get(f.project.id)?.filter(item => item.role === 'executor')).toHaveLength(1)
  } finally { release(); freeze.mockRestore(); await f.stop() }
}, 20000)

test.skipIf(process.platform === 'win32')('Given认领已落盘或Owner决定尚未提交 When强杀原生SQLite进程并重启 Then保留一次预留和一次合法决定', async () => {
  const stage = mkdtempSync(join(tmpdir(), 'owner-quality-native-'))
  const entry = join(stage, 'recovery.cjs')
  const node = execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()
  const env = { ...process.env, NODE_PATH: join(import.meta.dir, '../../../../../node_modules') }
  const run = (mode: string, projectId: string) => execFileSync(node, [entry, mode, projectId], { env, encoding: 'utf8', timeout: 20_000 })
  async function killAt(mode: string, projectId: string, marker: string): Promise<string> {
    const child = spawn(node, [entry, mode, projectId], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)))
    child.stderr.on('data', value => { errors += String(value) })
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`未到达强杀窗口：${output} ${errors}`)), 15_000)
        child.stdout.on('data', value => {
          output += String(value)
          if (output.includes(marker)) { clearTimeout(timeout); resolve() }
        })
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`子进程提前退出：${output} ${errors}`)) })
        child.once('error', cause => { clearTimeout(timeout); reject(cause) })
      })
    } finally { child.kill('SIGKILL') }
    expect(await exited).toBe('SIGKILL')
    return output
  }
  try {
    buildSync({ entryPoints: [join(import.meta.dir, 'project-owner-native-recovery-child.ts')], outfile: entry,
      bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      external: ['better-sqlite3', 'electron', 'original-fs', 'fsevents', 'playwright-core', 'chromium-bidi/lib/cjs/bidiMapper/BidiMapper', 'chromium-bidi/lib/cjs/cdp/CdpConnection'] })
    const queued = await fixture({ queueOnly: true })
    store.closeProjectDb()
    const claimed = await killAt('claim-after', queued.project.id, 'READY_OWNER_CLAIM')
    const claimedRows = JSON.parse(claimed.split('READY_OWNER_CLAIM ')[1]!.trim()) as Array<{ id: string; reserved_cost_micros: number }>
    const claimReplay = JSON.parse(run('claim-replay', queued.project.id).split('OWNER_CHAIN ')[1]!.trim())
    expect(claimedRows).toHaveLength(1)
    expect(claimReplay).toMatchObject({ recovered: [{ startBoundary: 'claim_only' }], replay: [], rows: [{
      id: claimedRows[0]!.id, reserved_cost_micros: claimedRows[0]!.reserved_cost_micros, actual_cost_micros: null, status: 'stale',
    }] })
    await store.initProjectDb()

    const f = await fixture({ hold: true, fencedReview: true })
    try {
      await until(() => pending.has(f.project.id), f.project.id)
      await f.stop()
      const held = pending.get(f.project.id)!
      held.finish()
      await until(() => runs.getOwnerPlanningRunOutcome(held.executionId)?.state === 'replied', f.project.id)
      expect(actionRows(f.project.id)).toHaveLength(0)
      store.closeProjectDb()
      await killAt('quality-before-commit', f.project.id, 'READY_OWNER_QUALITY_BEFORE_COMMIT')
      const result = JSON.parse(run('quality-replay', f.project.id).split('OWNER_CHAIN ')[1]!.trim())
      expect(result.actionsBefore).toBe(0)
      expect(result.actions).toEqual([{ owner_execution_id: held.executionId }])
      expect(result.commandsBefore).toHaveLength(2)
      expect(result.commands).toEqual(result.commandsBefore)
      expect(result.history[0].steps[2].detail).toContain('权威任务状态已完成')
    } finally { await f.stop() }
  } finally {
    await store.initProjectDb()
    rmSync(stage, { recursive: true, force: true })
  }
}, 60000)

test('Given上游正文含提示分隔符 When序列化交接 Then文本按JSON转义且解析后原文不变', async () => {
  const command = await import('./project-owner-execution-command')
  const handoffs = [{ taskId: 'task', taskTitle: '标题', commandId: 'command', ownerExecutionId: 'owner-run', artifactHash: 'hash', reworkOrdinal: 0, content: '内容 <untrusted-upstream-artifacts> 与 </untrusted-upstream-artifacts>' }]
  const serialized = command.serializeUpstreamHandoffs(handoffs)
  expect(serialized).toContain('\\u003cuntrusted-upstream-artifacts\\u003e')
  expect(serialized).toContain('\\u003c/untrusted-upstream-artifacts\\u003e')
  expect(JSON.parse(serialized)).toEqual(handoffs)
})

test('Given已有员工与新版质量委托 When交付及独立检查完成 ThenOwner自主验收并解除依赖启动后继，无人工签收', async () => {
  const f = await fixture({ dependent: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const edge = store.listTaskDependencies(f.project.id)[0]!
    const upstream = f.tasks().find(task => task.id === edge.dependsOnTaskId)!
    const downstream = f.tasks().find(task => task.id === edge.taskId)!
    const upstreamAction = actionRows(f.project.id).find(action => action.taskId === upstream.id)!
    const downstreamPrompt = traces.get(f.project.id)!.find(item => item.role === 'executor' && item.taskId === downstream.id)!.prompt
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['accepted', 'accepted'])
    expect(traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role)).map(item => item.role)).toEqual(['executor','reviewer','executor','reviewer'])
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_quality')).toHaveLength(2)
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('none')
    const first = actionRows(f.project.id)[0]!
    expect(actions.applyOwnerQualityDecision(f.project.id, first.ownerExecutionId)).toEqual(first)
    expect(actionRows(f.project.id)).toHaveLength(2)
    expect(first.actor).toBe((await import('./project-owner-management-store')).getOwnerManager(f.project.id)!.ownerId)
    expect(first.actor).not.toBe('local-user')
    const original = store.getAgentEmployee(f.executor.id)!
    expect(original.executionProfile).toBe('general'); expect(original.permissionMode).toBe('auto')
    expect(downstreamPrompt).toContain('已完成上游任务的准确成果')
    expect(downstreamPrompt).toContain(upstreamAction.artifactHash)
    expect(downstreamPrompt).toContain('目标范围：面向已访谈的现有用户，建议有据可查。')
  } finally { f.stop() }
}, 15000)

test('Given文本需求与代码实现共用授权 WhenOwner自主执行 Then文本验收后携带准确成果推进研发和独立评审', async () => {
  const f = await fixture({ development: true, mixedDelivery: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const edge = store.listTaskDependencies(f.project.id)[0]!
    const textTask = f.tasks().find(task => task.id === edge.dependsOnTaskId)!
    const codeTask = f.tasks().find(task => task.id === edge.taskId)!
    const reviews = (await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)
    expect(reviews).toHaveLength(2)
    expect(reviews.find(review => review.taskId === textTask.id)?.artifactVerified).toBe(true)
    expect(reviews.find(review => review.taskId === codeTask.id)?.validationEvidenceVerified).toBe(true)
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['accepted', 'accepted'])
    const downstream = traces.get(f.project.id)!.find(item => item.role === 'executor' && item.taskId === codeTask.id)!
    expect(downstream.prompt).toContain('目标范围：面向已访谈的现有用户，建议有据可查。')
    expect(downstream.prompt).toContain(actionRows(f.project.id)[0]!.artifactHash)
    expect(downstream.prompt).toContain('仅可修改已授权路径')
  } finally { await f.stop() }
}, 30000)

test('Given文字员工与研发员工各负责一步 WhenOwner自主执行 Then按冻结岗位派发并完成验收', async () => {
  const f = await fixture({ development: true, mixedDelivery: true, separateRoles: true })
  try {
    await until(() => f.tasks().length === 2 && f.tasks().every(task => task.status === 'completed'), f.project.id)
    const executions = store.getProjectDb().prepare("SELECT source_task_id,employee_id FROM project_owner_execution_commands WHERE grant_id=? AND role='executor'").all(f.grant.grantId) as Array<{ source_task_id: string; employee_id: string }>
    const textTask = f.tasks().find(task => task.title === '形成建议')!
    const codeTask = f.tasks().find(task => task.title === '修复代码')!
    expect(executions.find(item => item.source_task_id === textTask.id)?.employee_id).toBe(f.writer!.id)
    expect(executions.find(item => item.source_task_id === codeTask.id)?.employee_id).toBe(f.executor.id)
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['accepted', 'accepted'])
  } finally { await f.stop() }
}, 30000)

test.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('Given研发目标的父目录不存在 WhenOwner执行 Then安全创建目录并经实际Write门禁交付', async () => {
  const module = resolve(import.meta.dir, '../../../resources/owner-safe-directory/owner_safe_directory.node')
  if (!existsSync(module)) execFileSync('bun', ['run', 'build:owner-safe-directory'], { cwd: resolve(import.meta.dir, '../../..') })
  const f = await fixture({ development: true, nestedCode: true })
  try {
    await until(() => f.tasks().length === 1 && f.tasks()[0]!.status === 'completed', f.project.id)
    expect(actionRows(f.project.id)[0]?.state).toBe('accepted')
    const review = (await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)[0]!
    expect(review.developmentArtifact?.content).toContain('diary/index.html')
  } finally { await f.stop() }
}, 30000)

test('Given两个独立代码分支均已验收 When启动汇合任务 Then继承两份准确成果并独立验证', async () => {
  const f = await fixture({ development: true, forkedCode: true })
  try {
    await until(() => f.tasks().length === 3 && f.tasks().every(task => task.status === 'completed'), f.project.id)
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['accepted', 'accepted', 'accepted'])
    const reviews = (await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)
    expect(reviews).toHaveLength(3)
    expect(reviews.every(review => review.artifactVerified && review.validationEvidenceVerified)).toBe(true)
  } finally { await f.stop() }
}, 30000)

test('Given文本需求和并行代码分支 WhenOwner执行完整计划 Then合并分支并逐项验收', async () => {
  const f = await fixture({ development: true, forkedCode: true, mixedDelivery: true })
  try {
    await until(() => f.tasks().length === 4 && f.tasks().every(task => task.status === 'completed'), f.project.id)
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['accepted', 'accepted', 'accepted', 'accepted'])
    const reviews = (await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)
    expect(reviews).toHaveLength(4)
    expect(reviews.filter(review => review.validationEvidenceVerified)).toHaveLength(3)
  } finally { await f.stop() }
}, 45000)

test('Given质量判断在途且同方案安排已准备 When成果验收并交付 Then旧安排与后续授权事件都不再调用模型', async () => {
  const f = await fixture({ hold: true })
  const assignment = await import('./project-owner-management-assignment')
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const db = store.getProjectDb()
    const plan = plans.getProjectOwnerPlanDraft(f.project.id)!
    const arrangementLinks = () => (db.prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload, '$.purpose')='owner_execution_assignment' ORDER BY rowid").all(f.project.id) as Array<{ planning_task_id: string }>).map(row => row.planning_task_id)
    const before = arrangementLinks()
    assignment.prepareOwnerManagementAssignment({ id: `pre-delivery-arrangement:${randomUUID()}`, projectId: f.project.id, kind: 'team_changed', sourceRevision: plan.revision, createdAt: Date.now(), consumedAt: null })
    const prepared = arrangementLinks()
    expect(prepared.length).toBe(before.length + 1)
    const pendingTaskId = prepared.at(-1)!
    expect(store.listAgentExecutionsByEntity('task', pendingTaskId)).toHaveLength(0)

    pending.get(f.project.id)!.finish()
    await until(() => (db.prepare("SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery'").get(f.project.id) as { count: number }).count === 1, f.project.id)
    await Bun.sleep(150)
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_arrangement')).toHaveLength(0)
    expect(store.listAgentExecutionsByEntity('task', pendingTaskId)).toHaveLength(0)

    assignment.prepareOwnerManagementAssignment({ id: `post-delivery-arrangement:${randomUUID()}`, projectId: f.project.id, kind: 'team_changed', sourceRevision: plan.revision, createdAt: Date.now(), consumedAt: null })
    expect(arrangementLinks()).toEqual(prepared)
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_arrangement')).toHaveLength(0)
  } finally { f.stop() }
}, 15000)

test('Given账本中有已验收旧授权与较新未完成授权 WhenOwner恢复管理循环 Then旧批次仍先交付到同一对话', async () => {
  const f = await fixture({ hold: true })
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const db = store.getProjectDb()
    const prior = db.prepare('SELECT * FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId) as Record<string, unknown>
    const columns = Object.keys(prior)
    const values = columns.map(column => column === 'id' ? randomUUID() : column === 'state' ? 'paused' : column === 'request_id' ? randomUUID() : column === 'issued_at' ? Number(prior.issued_at) + 1 : prior[column]) as Array<string | number | null>
    db.prepare(`INSERT INTO project_owner_execution_grants (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values)

    pending.get(f.project.id)!.finish()
    await until(() => actionRows(f.project.id).some(action => action.grantId === f.grant.grantId && action.state === 'accepted'), f.project.id)
    management.reconcileOwnerManagement(f.project.id)

    const messages = (db.prepare('SELECT payload FROM project_owner_management_messages WHERE project_id=?').all(f.project.id) as Array<{ payload: string }>).map(row => JSON.parse(row.payload) as { eventId: string; kind: string; delivery?: { schemaVersion: number; items: Array<{ artifactHash: string }> } }).filter(message => message.kind === 'delivery')
    const oldAction = actionRows(f.project.id).find(action => action.grantId === f.grant.grantId)!
    expect(messages).toHaveLength(1)
    expect(messages[0]!.eventId).toStartWith(`owner-delivery:${f.grant.grantId}:`)
    expect(messages[0]!.delivery).toMatchObject({ schemaVersion: 1, items: [{ artifactHash: oldAction.artifactHash }] })
  } finally { f.stop() }
}, 15000)

test('Given旧授权成果已被Owner验收且计划产生新重验证版本 When恢复管理循环 Then旧成果仍按原授权和成果哈希交付', async () => {
  const f = await fixture({ hold: true })
  const deliveryService = await import('./project-owner-management-delivery')
  const deliverySpy = spyOn(deliveryService, 'publishOwnerManagementCompletion').mockImplementation(() => false)
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    pending.get(f.project.id)!.finish()
    await until(() => actionRows(f.project.id).some(action => action.grantId === f.grant.grantId && action.state === 'accepted'), f.project.id)

    const revokeService = await import('./project-owner-execution-grant-issue')
    const subject = { projectId: f.project.id }
    const revoke = revokeService.previewOwnerExecutionGrantRevoke(subject, { grantId: f.grant.grantId })
    expect(revoke.blockers).toEqual([])
    expect(revokeService.confirmOwnerExecutionGrantRevoke(subject, { grantId: f.grant.grantId, confirmedFingerprint: revoke.fingerprint }).state).toBe('paused')

    const goal = goals.saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '按新目标追加交付' })
    const context = plans.getProjectOwnerPlanningContext(f.project.id)
    const oldPlan = plans.getProjectOwnerPlanDraft(f.project.id)!
    const roleKey = context.sources.roles[0]!.key
    const proposed = plans.saveProjectOwnerPlanDraft(f.project.id, goal.revision, oldPlan.revision, {
      expectedContextFingerprint: context.fingerprint,
      summary: '追加一批新计划',
      assumptions: [], risks: [],
      steps: [{ key: 'brief-v2', title: '补充新研究', outcome: '新增材料', acceptanceCriteria: ['满足修订目标'], dependencies: [], roleKey }],
      changeReason: '验收旧成果后按新目标继续',
    })
    const confirmed = plans.confirmProjectOwnerPlanDraft(f.project.id, goal.revision, proposed.revision)
    const policyService = await import('./project-pilot-policy')
    const currentPreparation = prep.getOwnerExecutionPreparation(subject).preparation!
    const nextPreparationInput = {
      ...currentPreparation.input,
      requestId: randomUUID(),
      expectedPreparationRevision: currentPreparation.revision,
      expectedPolicyRevision: policyService.getPilotPolicy(f.project.id)!.revision,
      expectedGoalRevision: goal.revision,
      expectedPlanRevision: confirmed.revision,
      selectedStepKeys: ['brief-v2'],
      changeReason: '追加新计划任务',
    }
    const preparationPreview = prep.previewOwnerExecutionPreparation(subject, nextPreparationInput)
    const nextPreparation = prep.saveOwnerExecutionPreparation(subject, nextPreparationInput, preparationPreview.previewFingerprint)
    const currentMaterialization = material.getOwnerTaskMaterialization(subject).materialization!
    const materializationInput = {
      requestId: randomUUID(),
      expectedMaterializationRevision: currentMaterialization.revision,
      expectedPreparationId: nextPreparation.id,
      expectedPreparationRevision: nextPreparation.revision,
      expectedPreparationHash: nextPreparation.integrityHash,
      expectedPolicyRevision: nextPreparation.policyRevision,
    }
    const materializationPreview = material.previewOwnerTaskMaterialization(subject, materializationInput)
    const nextMaterialization = material.materializeOwnerTasks(subject, materializationInput, materializationPreview.previewFingerprint)
    const revalidation = await import('./project-owner-execution-revalidation')
    const revalidationInput = {
      requestId: randomUUID(),
      expectedRevalidationRevision: f.grant.revalidationRevision,
      expectedMaterializationId: nextMaterialization.id,
      expectedMaterializationRevision: nextMaterialization.revision,
      expectedMaterializationHash: nextMaterialization.integrityHash,
      expectedPolicyRevision: nextPreparation.policyRevision,
      changeReason: '核对新增计划批次',
    }
    const revalidationPreview = revalidation.previewOwnerExecutionRevalidation(subject, revalidationInput)
    const newerRevalidation = revalidation.saveOwnerExecutionRevalidation(subject, revalidationInput, revalidationPreview.previewFingerprint)
    expect(newerRevalidation.id).not.toBe(f.grant.revalidationId)

    f.stop()
    deliverySpy.mockRestore()
    const db = store.getProjectDb()
    db.prepare("UPDATE project_owner_execution_grants SET state='active' WHERE id=?").run(f.grant.grantId)
    expect(deliveryService.publishOwnerManagementCompletion(f.project.id)).toBe(false)
    db.prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=?").run(f.grant.grantId)
    expect(deliveryService.publishOwnerManagementCompletion(f.project.id)).toBe(true)
    const messages = db.prepare('SELECT payload FROM project_owner_management_messages WHERE project_id=?').all(f.project.id) as Array<{ payload: string }>
    const deliveries = messages.map(row => JSON.parse(row.payload) as { eventId: string; kind: string; delivery?: { schemaVersion: number; items: Array<{ artifactHash: string }> } }).filter(message => message.kind === 'delivery')
    const oldAction = actionRows(f.project.id).find(action => action.grantId === f.grant.grantId)!
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.eventId).toStartWith(`owner-delivery:${f.grant.grantId}:`)
    expect(deliveries[0]!.delivery).toMatchObject({ schemaVersion: 1, items: [{ artifactHash: oldAction.artifactHash }] })
  } finally { deliverySpy.mockRestore(); f.stop() }
}, 15000)

test('GivenOwner反馈修订方案 WhenRenderer确认Atom经正式IPC启动 Then新版自动复核并回到原对话', async () => {
  const f = await fixture({ dependent: true, durableStartIntent: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const intent = store.getProjectDb().prepare('SELECT state,grant_id FROM project_owner_execution_start_intents WHERE project_id=?').get(f.project.id) as { state: string; grant_id: string }
    const commands = store.getProjectDb().prepare('SELECT role,employee_id,state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(f.grant.grantId) as { role: string; employee_id: string; state: string }[]
    const edge = store.listTaskDependencies(f.project.id)[0]!
    const downstreamTask = f.tasks().find(task => task.id === edge.taskId)!
    const downstreamPrompt = traces.get(f.project.id)!.find(item => item.role === 'executor' && item.taskId === downstreamTask.id)!.prompt
    expect(intent).toEqual({ state: 'completed', grant_id: f.grant.grantId })
    expect(commands.map(command => [command.role, command.employee_id, command.state])).toEqual([
      ['executor', f.executor.id, 'settled'], ['reviewer', f.reviewer.id, 'settled'],
      ['executor', f.executor.id, 'settled'], ['reviewer', f.reviewer.id, 'settled'],
    ])
    expect(actionRows(f.project.id).map(action => action.state)).toEqual(['accepted', 'accepted'])
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_quality')).toHaveLength(2)
    await until(() => (store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery'").get(f.project.id) as { count: number }).count === 1, f.project.id)
    const delivered = JSON.parse((store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery'").get(f.project.id) as { payload: string }).payload) as { delivery: { items: Array<{ artifactHash: string; content: string }> } }
    const acceptedActions = actionRows(f.project.id)
    expect(delivered.delivery.items).toHaveLength(2)
    expect(delivered.delivery.items.map(item => item.artifactHash)).toEqual(acceptedActions.map(action => action.artifactHash))
    expect(delivered.delivery.items[0]?.content).toContain('目标范围：面向已访谈的现有用户')
    expect(downstreamPrompt).toContain('已完成上游任务的准确成果')
    expect(downstreamPrompt).toContain('目标范围：面向已访谈的现有用户，建议有据可查。')
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('none')

    const priorGrantCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { count: number }).count
    const priorCommandCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE project_id=?').get(f.project.id) as { count: number }).count
    const priorExecutorRuns = traces.get(f.project.id)!.filter(item => item.role === 'executor').length
    const conversation = managementConversation.getOwnerManagementConversation(f.project.id)
    const deliveredMessage = conversation.messages.find(message => message.kind === 'delivery')!
    const feedbackItem = deliveredMessage.delivery!.items[0]!
    const feedback = sendOwnerManagementMessage({ projectId: f.project.id, conversationId: deliveredMessage.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '请在这份建议中补充目标用户分析', deliveryReference: { messageId: deliveredMessage.id, artifactHash: feedbackItem.artifactHash, stepKey: feedbackItem.stepKey } })
    let feedbackPlanningTaskId: string | undefined
    await until(() => {
      const row = store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload,'$.conversationMessageId')=? ORDER BY rowid DESC LIMIT 1").get(f.project.id, feedback.id) as { planning_task_id: string } | undefined
      feedbackPlanningTaskId = row?.planning_task_id
      return Boolean(row && store.listAgentExecutionsByEntity('task', row.planning_task_id).some(item => item.status === 'completed'))
    }, f.project.id)
    const feedbackSource = source.readOwnerPlanningSnapshot(feedbackPlanningTaskId!)!
    expect(feedbackSource.context.conversation?.deliveryFeedback).toMatchObject({ messageId: deliveredMessage.id, artifactHash: feedbackItem.artifactHash, stepKey: feedbackItem.stepKey, title: feedbackItem.title, content: feedbackItem.content, acceptanceCriteria: feedbackItem.acceptanceCriteria })
    await until(() => {
      const plan = plans.getProjectOwnerPlanDraft(f.project.id)
      return plan?.state === 'proposed' && plan.proposal.deliveryFeedbackAssessment?.messageId === deliveredMessage.id && plan.proposal.deliveryFeedbackAssessment.artifactHash === feedbackItem.artifactHash && plan.proposal.deliveryFeedbackAssessment.stepKey === feedbackItem.stepKey
    }, f.project.id)
    const revisedPlan = plans.getProjectOwnerPlanDraft(f.project.id)!
    expect(revisedPlan.state).toBe('proposed')
    expect(revisedPlan.proposal.deliveryFeedbackAssessment).toMatchObject({ messageId: deliveredMessage.id, artifactHash: feedbackItem.artifactHash, stepKey: feedbackItem.stepKey, authorizationImpact: 'within_confirmed_boundary' })
    expect(revisedPlan.proposal.steps.flatMap(step => step.acceptanceCriteria)).toEqual(feedbackItem.acceptanceCriteria)
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_feedback')).toHaveLength(1)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_grants WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(priorGrantCount)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(priorCommandCount)

    const currentPreparation = prep.getOwnerExecutionPreparation({ projectId: f.project.id })
    const nextInput: OwnerExecutionPreparationInput = { ...currentPreparation.preparation!.input, requestId: randomUUID(), expectedPreparationRevision: currentPreparation.revision,
      expectedPolicyRevision: currentPreparation.policyRevision, expectedGoalRevision: 1, expectedPlanRevision: revisedPlan.revision,
      selectedStepKeys: revisedPlan.proposal.steps.map(step => step.key), changeReason: '按用户反馈修订已交付成果' }
    const intentCalls = await confirmFeedbackThroughRenderer(f.project.id, revisedPlan, nextInput)
    expect(intentCalls).toEqual([{ action: 'save', intentId: nextInput.requestId }, { action: 'resume', intentId: nextInput.requestId }])
    await until(() => (store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery'").get(f.project.id) as { count: number }).count === 2, f.project.id)
    const deliveries = (store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload, '$.kind')='delivery' ORDER BY rowid").all(f.project.id) as { payload: string }[])
      .map(row => JSON.parse(row.payload) as { id: string; eventId: string; delivery: { items: Array<{ stepKey: string; content: string }> } })
    const grantHistory = (await import('./project-owner-execution-grant-issue')).listOwnerExecutionGrantHistory({ projectId: f.project.id })
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]!.id).toBe(deliveredMessage.id)
    expect(deliveries[0]!.delivery.items[0]?.content).toBe(feedbackItem.content)
    expect(deliveries[1]!.eventId).toContain(grantHistory.at(-1)!.grantId)
    expect(grantHistory).toHaveLength(priorGrantCount + 1)
    expect(grantHistory.at(-1)).toMatchObject({ state: 'active', materializationId: expect.not.stringMatching(f.grant.materializationId) })
    expect(deliveries[1]!.delivery.items).toMatchObject([{ stepKey: 'revise-delivery', content: expect.stringContaining('目标范围：面向已访谈的现有用户') }])
    expect(traces.get(f.project.id)!.filter(item => item.role === 'executor')).toHaveLength(priorExecutorRuns + 1)
    expect(actionRows(f.project.id).slice(-1).map(action => action.state)).toEqual(['accepted'])
  } finally { f.stop() }
}, 15000)

test.each([false, true])('Given旧批次因质量问题待协商 When用户回复修订且费用待核对=%s Then依据旧账本决定是否续派', async (unsettled) => {
  const f = await fixture({ escalate: true })
  try {
    await until(() => actionRows(f.project.id).some(action => action.state === 'escalated'), f.project.id)
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('human_decision')
    const db = store.getProjectDb()
    if (unsettled) {
      db.prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE command_id IN (SELECT id FROM project_owner_execution_commands WHERE grant_id=?)").run(f.grant.grantId)
    }
    const { getOwnerManager } = await import('./project-owner-management-store')
    const subject = { projectId: f.project.id }
    sendOwnerManagementMessage({ ...subject, conversationId: getOwnerManager(f.project.id)!.conversationId,
      requestId: randomUUID(), expectedGoalRevision: 1, content: '请保留旧成果，并在原目标内补充核验。' })
    if (unsettled) {
      await until(() => Boolean(db.prepare("SELECT id FROM project_owner_execution_start_intents WHERE project_id=? AND recovery_status='needs_attention'").get(f.project.id)), f.project.id)
      expect(executionGrants.listOwnerExecutionGrantHistory(subject).map(item => item.state)).toEqual(['active'])
      return
    }
    await until(() => executionGrants.getOwnerExecutionGrant(subject)?.grantId !== f.grant.grantId, f.project.id)
    const grant = executionGrants.getOwnerExecutionGrant(subject)!
    expect(grant.materializationId).not.toBe(f.grant.materializationId)
    expect(executionGrants.listOwnerExecutionGrantHistory(subject).map(item => item.state)).toEqual(['paused', 'active'])
    expect(actionRows(f.project.id)[0]).toMatchObject({ grantId: f.grant.grantId, state: 'escalated' })
    const intent = db.prepare("SELECT id FROM project_owner_execution_start_intents WHERE project_id=? AND grant_id=? AND state='completed'").get(f.project.id, grant.grantId) as { id: string } | undefined
    expect(intent).toBeDefined()
    const start = await import('./project-owner-execution-start-intent')
    expect((await start.resumeOwnerExecutionStartIntent(intent!.id, subject)).grantId).toBe(grant.grantId)
    await until(() => actionRows(f.project.id).some(action => action.grantId === grant.grantId && action.state === 'accepted'), f.project.id)
    await until(() => Boolean(db.prepare("SELECT id FROM project_owner_management_messages WHERE project_id=? AND event_id LIKE ? AND json_extract(payload,'$.kind')='delivery'")
      .get(f.project.id, `owner-delivery:${grant.grantId}:%`)), f.project.id)
  } finally { await f.stop() }
}, 15000)

test.each([false, true])('Given验证缺口阻断旧批次 When用户要求继续且费用待核对=%s Then保留旧记录并依据账本决定续派', async (unsettled) => {
  const f = await fixture({ development: true, evidenceGap: true, blockedContinuation: true })
  try {
    await until(() => actionRows(f.project.id).some(action => action.state === 'blocked'), f.project.id)
    const db = store.getProjectDb()
    if (unsettled) db.prepare("UPDATE project_owner_execution_request_reservations SET state='needs_reconcile' WHERE command_id IN (SELECT id FROM project_owner_execution_commands WHERE grant_id=?)").run(f.grant.grantId)
    const { getOwnerManager } = await import('./project-owner-management-store')
    const subject = { projectId: f.project.id }
    sendOwnerManagementMessage({ ...subject, conversationId: getOwnerManager(f.project.id)!.conversationId,
      requestId: randomUUID(), expectedGoalRevision: 1, content: '请保留旧成果，并在原目标内补充核验。' })
    if (unsettled) {
      await until(() => Boolean(db.prepare("SELECT id FROM project_owner_execution_start_intents WHERE project_id=? AND recovery_status='needs_attention'").get(f.project.id)), f.project.id)
      expect(executionGrants.listOwnerExecutionGrantHistory(subject).map(item => item.state)).toEqual(['active'])
    } else {
      await until(() => executionGrants.getOwnerExecutionGrant(subject)?.grantId !== f.grant.grantId, f.project.id)
      expect(executionGrants.listOwnerExecutionGrantHistory(subject).map(item => item.state)).toEqual(['paused', 'active'])
      expect(actionRows(f.project.id)[0]).toMatchObject({ grantId: f.grant.grantId, state: 'blocked' })
    }
  } finally { await f.stop() }
}, 30000)

test('Given代码任务交付且白名单验证成功 WhenReviewer与Owner检查同一冻结快照 ThenOwner验收并解除依赖', async () => {
  const f = await fixture({ development: true, dependent: true, checkInherited: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const commands = store.getProjectDb().prepare("SELECT id,role,rework_ordinal,state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at").all(f.grant.grantId) as { id: string; role: string; rework_ordinal: number; state: string }[]
    expect(commands.map(item => [item.role, item.rework_ordinal, item.state])).toEqual([
      ['executor', 0, 'settled'], ['reviewer', 0, 'settled'], ['executor', 0, 'settled'], ['reviewer', 0, 'settled'],
    ])
    const reviews = (await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)
    expect(reviews).toHaveLength(2)
    expect(reviews.every(item => item.verdict === 'approved' && item.artifactVerified && item.validationEvidenceVerified)).toBe(true)
    expect(reviews.every(item => item.validationEvidence?.length === 1 && item.validationEvidence[0]?.status === 'passed' && item.validationEvidence[0]?.outputTruncated === false)).toBe(true)
    const validations = await import('./development-validation-service')
    for (const review of reviews) {
      const evidence = review.validationEvidence![0]!
      const saved = validations.readDevelopmentValidationEvidence(review.taskId, review.executorExecutionId, evidence.validationId)
      expect(saved.freshness).toBe('fresh')
      if (!review.artifactHash) throw new Error('已批准评审缺少成果摘要')
      expect(saved.result.snapshotContentHash).toBe(review.artifactHash)
      expect(saved.result.rawOutputSha256).toEqual(evidence.rawOutputSha256)
    }
    const actions = actionRows(f.project.id)
    expect(actions.map(item => item.state)).toEqual(['accepted', 'accepted'])
    expect(actions.every(item => item.decision.artifactHash === reviews.find(review => review.taskId === item.taskId)?.artifactHash)).toBe(true)
    await until(() => Boolean(store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload,'$.kind')='delivery'").get(f.project.id)), f.project.id)
    const conversation = (await import('./project-owner-management-questions')).getOwnerManagementConversation(f.project.id)
    const delivery = conversation.messages.find(message => message.kind === 'delivery')!
    expect(conversation.deliveryValidations).toHaveLength(2)
    expect(conversation.deliveryValidations!.every(record => record.messageId === delivery.id && delivery.delivery!.items.some(item => item.stepKey === record.stepKey && item.artifactHash === record.artifactHash) && record.validations[0]?.status === 'passed')).toBe(true)
    expect(conversation.deliveryValidations!.every(record => record.validations[0]?.method === 'command' && record.validations[0]?.freshness === 'fresh')).toBe(true)
    const projected = (await import('./project-owner-management-delivery')).listOwnerDeliveryValidations
    expect(projected(f.project.id, [{ ...delivery, eventId: `${delivery.eventId}0` }])).toMatchObject([{ unavailable: true }, { unavailable: true }])
    expect(projected(f.project.id, [{ ...delivery, delivery: { ...delivery.delivery!, items: delivery.delivery!.items.map(item => ({ ...item, artifactHash: 'f'.repeat(64) })) } }])).toEqual([])
    expect(traces.get(f.project.id)!.filter(item => ['executor', 'reviewer', 'owner_quality'].includes(item.role)).map(item => item.role)).toEqual([
      'executor', 'reviewer', 'owner_quality', 'executor', 'reviewer', 'owner_quality',
    ])
    const dependency = store.listTaskDependencies(f.project.id)[0]!
    const downstream = f.tasks().find(task => task.id === dependency.taskId)!
    const downstreamPrompt = traces.get(f.project.id)!.find(item => item.role === 'executor' && item.taskId === downstream.id)!.prompt
    expect(downstreamPrompt).toContain('已完成上游任务的准确成果')
    expect(downstreamPrompt).toContain(actions[0]!.artifactHash)
    expect(downstreamPrompt).toContain('module.exports = { answer: 42 }')
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('none')
    const firstReceipt = runs.getOwnerPlanningRunReceipt(actions[0]!.ownerReceiptId)!
    const item = delivery.delivery!.items[0]!
    const request = { projectId: f.project.id, conversationId: conversation.manager!.conversationId, requestId: randomUUID(), expectedGoalRevision: goals.getProjectOwnerGoalDraft(f.project.id)!.revision, content: '认可这个成果版本', deliveryReference: { messageId: delivery.id, stepKey: item.stepKey, artifactHash: item.artifactHash }, deliveryReviewDecision: 'accepted' as const }
    const conversationService = await import('./project-owner-management-conversation')
    const db = store.getProjectDb()
    const grant = db.prepare('SELECT materialization_integrity_hash FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId) as { materialization_integrity_hash: string }
    db.prepare('UPDATE project_owner_execution_grants SET materialization_integrity_hash=? WHERE id=?').run('0'.repeat(64), f.grant.grantId)
    try {
      expect(projected(f.project.id, [delivery]).find(record => record.stepKey === item.stepKey)).toMatchObject({ unavailable: true })
      expect(() => conversationService.sendOwnerManagementMessage(request)).toThrow('验证证据无法核对')
    } finally {
      db.prepare('UPDATE project_owner_execution_grants SET materialization_integrity_hash=? WHERE id=?').run(grant.materialization_integrity_hash, f.grant.grantId)
    }
    const clock = spyOn(Date, 'now').mockReturnValue(firstReceipt.capturedAt + 366 * 24 * 60 * 60 * 1000)
    try {
      expect(actionRows(f.project.id)).toEqual(actions)
      expect(() => conversationService.sendOwnerManagementMessage(request)).toThrow('验证证据已过期')
      expect(conversationService.sendOwnerManagementMessage({ ...request, requestId: randomUUID(), deliveryReviewDecision: 'deferred' }).deliveryReviewDecision).toBe('deferred')
    } finally { clock.mockRestore() }
  } finally { f.stop() }
}, 120000)

test.skipIf(process.platform !== 'darwin')('Given代码交付需要浏览器验证 When真实Electron执行断言并经Owner质量链交付 Then准确版本显示逐项证据', async () => {
  const entry = join(directory, 'real-browser-runner.ts'), bundle = join(directory, 'real-browser-runner.cjs')
  const verifierPath = join(import.meta.dir, 'owner-runtime-browser-verifier.ts')
  writeFileSync(entry, `import { app } from 'electron'; import { dirname, basename, join } from 'node:path'; import { runOwnerRuntimeBrowserAssertions } from ${JSON.stringify(verifierPath)}; app.setPath('userData',join(dirname(process.argv[1]),'electron-user-data')); app.on('window-all-closed',()=>{}); app.whenReady().then(async()=>{const input=JSON.parse(Buffer.from(process.argv[2],'base64').toString('utf8'));const result=await runOwnerRuntimeBrowserAssertions({workspaceRoot:dirname(input.filePath),relativePath:basename(input.filePath),intents:[],templates:input.templates,timeoutMs:input.timeoutMs});process.stdout.write('RESULT:'+JSON.stringify(result)+'\\n');app.exit(0)}).catch(error=>{process.stderr.write(String(error.stack||error));app.exit(1)});`)
  buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const browser = await import('./owner-runtime-browser-verifier')
  browser.setOwnerRuntimeBrowserRunner(async input => {
    const binary = resolve(import.meta.dir, '../../../../..', 'node_modules/.bin/electron')
    const output = execFileSync(binary, [bundle, Buffer.from(JSON.stringify(input)).toString('base64')], { encoding: 'utf8', timeout: 30000 })
    const result = output.split('\n').find(line => line.startsWith('RESULT:'))
    if (!result) throw new Error('真实Electron没有返回浏览器验证结果')
    return JSON.parse(result.slice('RESULT:'.length)) as import('./owner-runtime-browser-verifier').OwnerRuntimeBrowserRunResult
  })
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    f = await fixture({ development: true, browserValidation: true })
    await until(() => f!.tasks().every(task => task.status === 'completed'), f.project.id)
    await until(() => Boolean(store.getProjectDb().prepare("SELECT id FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload,'$.kind')='delivery'").get(f!.project.id)), f.project.id)
    const view = managementConversation.getOwnerManagementConversation(f.project.id)
    const delivery = view.messages.find(message => message.kind === 'delivery')!
    const record = view.deliveryValidations?.find(item => item.messageId === delivery.id && item.artifactHash === delivery.delivery?.items[0]?.artifactHash)
    expect(record?.validations[0]).toMatchObject({ method: 'browser_assertions', status: 'passed', freshness: 'fresh', checks: [{ id: 'html.loads', status: 'passed' }] })
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { OwnerDeliveredArtifact } = await import('../../renderer/components/projects/OwnerDeliveredArtifact')
    const markup = renderToStaticMarkup(createElement(OwnerDeliveredArtifact, { item: delivery.delivery!.items[0]!, validation: record }))
    expect(markup).toContain('浏览器断言：browser:html.loads')
    expect(markup).toContain('页面可加载且无脚本错误：通过')
    const deliveryProjection = await import('./project-owner-management-delivery')
    expect(deliveryProjection.listOwnerDeliveryValidations(f.project.id, [{ ...delivery, eventId: `${delivery.eventId}0` }])).toMatchObject([{ unavailable: true, validations: [] }])
    const review = (await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)[0]!
    const execution = store.getAgentExecution(review.executorExecutionId)!
    const workspace = workspaces.getAgentWorkspace(f.input.workspaceId!)!
    const sessionDir = (await import('./config-paths')).getAgentSessionWorkspacePath(workspace.slug, execution.sessionId)
    const evidencePath = join(sessionDir, `development-validation-${review.validationEvidence![0]!.validationId}.json`)
    const original = readFileSync(evidencePath, 'utf8')
    const altered = JSON.parse(original) as { checks: Array<{ detail: string }> }
    altered.checks[0]!.detail = '修改后的断言说明'
    writeFileSync(evidencePath, JSON.stringify(altered))
    try {
      const untrusted = managementConversation.getOwnerManagementConversation(f.project.id).deliveryValidations?.[0]?.validations[0]
      expect(untrusted?.freshness).toBe('unknown')
      expect(untrusted?.checks).toBeUndefined()
    } finally { writeFileSync(evidencePath, original) }
  } finally { if (f) await f.stop(); browser.setOwnerRuntimeBrowserRunner(null) }
}, 120000)

test('Given代码白名单验证失败且Reviewer仍声称通过 WhenOwner质量链续跑 Then拒绝保存通过评审与质量验收且不启动后继', async () => {
  const f = await fixture({ development: true, dependent: true, validationFails: true })
  try {
    await until(() => {
      const reviewer = store.getProjectDb().prepare("SELECT state FROM project_owner_execution_commands WHERE grant_id=? AND role='reviewer' ORDER BY created_at LIMIT 1").get(f.grant.grantId) as { state: string } | undefined
      return Boolean(reviewer && !['reserved', 'queued', 'running'].includes(reviewer.state))
    }, f.project.id)
    const commands = store.getProjectDb().prepare('SELECT role,state FROM project_owner_execution_commands WHERE grant_id=? ORDER BY created_at').all(f.grant.grantId) as { role: string; state: string }[]
    expect(commands.map(item => item.role)).toEqual(['executor', 'reviewer'])
    expect(commands.every(item => item.state === 'settled')).toBe(true)
    const validations = await import('./development-validation-service')
    const executor = store.getProjectDb().prepare("SELECT execution_id,source_task_id FROM project_owner_execution_commands WHERE grant_id=? AND role='executor'").get(f.grant.grantId) as { execution_id: string; source_task_id: string }
    const validation = validations.listDevelopmentValidations(executor.source_task_id).find(item => item.executionId === executor.execution_id)
    expect(validation).toMatchObject({ status: 'failed', exitCode: 1 })
    expect((await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)).toHaveLength(0)
    const messages = (await import('./project-owner-management-store')).getOwnerManagementView(f.project.id).messages
    expect(messages.some(message => message.eventId.startsWith('owner-review-evidence-rejected:') && message.content.includes('没有可采信的评审结果'))).toBe(true)
    expect(messages.some(message => message.kind === 'delivery')).toBe(false)
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(f.tasks().every(task => task.status === 'paused')).toBe(true)
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_quality')).toHaveLength(0)
    const downstreamTask = f.tasks().find(task => task.id !== executor.source_task_id)!
    expect(traces.get(f.project.id)!.filter(item => item.role === 'executor' && item.taskId === downstreamTask.id)).toHaveLength(0)
  } finally { f.stop() }
}, 120000)

test('Given后继命令已排队 When启动前预算不足或上游成果变化/提示被追加 Then拒绝使用旧冻结交接', async () => {
  const f = await fixture({ dependent: true, hold: true })
  let deliveryPath = ''
  let originalDelivery: Buffer | undefined
  try {
    await until(() => pending.has(f.project.id))
    const held = pending.get(f.project.id)!
    f.stop()
    held.finish()
    await until(() => Boolean(runs.getOwnerPlanningRunOutcome(held.executionId)?.qualityDecision))
    const accepted = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
    expect(accepted.state).toBe('accepted')

    const edge = store.listTaskDependencies(f.project.id)[0]!
    const downstream = f.tasks().find(task => task.id === edge.taskId)!
    const executor = store.getProjectDb().prepare("SELECT execution_id FROM project_owner_execution_commands WHERE source_task_id=? AND role='executor' AND state='settled'").get(edge.dependsOnTaskId) as { execution_id: string }
    const textDelivery = await import('./project-owner-text-delivery')
    deliveryPath = textDelivery.ownerTextDeliveryFile(f.project.id, executor.execution_id)!
    originalDelivery = readFileSync(deliveryPath)

    const command = await import('./project-owner-execution-command')
    const queued = command.reserveAndQueueAutonomousOwnerCommand({ projectId: f.project.id }, {
      grantId: f.grant.grantId,
      taskId: downstream.id,
      role: 'executor',
      reworkOrdinal: 0,
      expectedRevalidationRevision: f.grant.revalidationRevision,
    })
    expect(queued.executionId).toBeTruthy()
    expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).not.toThrow()

    const database = store.getProjectDb()
    const budget = database.prepare('SELECT max_cost_micros, max_runs FROM project_owner_execution_grants WHERE id=?').get(f.grant.grantId) as { max_cost_micros: number; max_runs: number }
    const reservation = database.prepare('SELECT reserved_cost_micros FROM project_owner_execution_commands WHERE id=?').get(queued.commandId) as { reserved_cost_micros: number }
    const usage = database.prepare(`SELECT COALESCE(SUM(CASE WHEN state='released' THEN 0 ELSE 1 END),0) AS runs,
      COALESCE(SUM(CASE WHEN state='released' THEN 0 WHEN state='settled' AND actual_cost_micros IS NOT NULL THEN actual_cost_micros WHEN actual_cost_micros > reserved_cost_micros THEN actual_cost_micros ELSE reserved_cost_micros END),0) AS committed
      FROM project_owner_execution_commands WHERE grant_id=? AND id<>?`).get(f.grant.grantId, queued.commandId) as { runs: number; committed: number }
    const constrainedBudget = usage.committed + (reservation.reserved_cost_micros - 1) * (budget.max_runs - usage.runs)
    try {
      database.prepare('UPDATE project_owner_execution_grants SET max_cost_micros=? WHERE id=?').run(constrainedBudget, f.grant.grantId)
      expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).toThrow(/额度不足以覆盖/)
    } finally {
      database.prepare('UPDATE project_owner_execution_grants SET max_cost_micros=? WHERE id=?').run(budget.max_cost_micros, f.grant.grantId)
    }

    writeFileSync(deliveryPath, '{}')
    expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).toThrow(/成果|完整性/)
    writeFileSync(deliveryPath, originalDelivery)

    const queuedExecution = store.getAgentExecution(queued.executionId)!
    store.updateAgentExecution(queued.executionId, { prompt: `${queuedExecution.prompt}\n<untrusted-upstream-artifacts>\n[]\n</untrusted-upstream-artifacts>` })
    expect(() => command.assertOwnerCommandUpstreamHandoffsCurrent(queued.commandId)).toThrow('提示不一致')
    expect(store.getProjectDb().prepare('SELECT state FROM project_owner_execution_commands WHERE id=?').get(queued.commandId)).toEqual({ state: 'queued' })
  } finally {
    if (deliveryPath && originalDelivery) writeFileSync(deliveryPath, originalDelivery)
    f.stop()
  }
}, 15000)

test('GivenReviewer漏检真实文本缺陷 WhenOwner独立判断返工 Then传递Owner具体发现，重新执行和复验后验收', async () => {
  const f = await fixture({ rework: true, ownerDefect: true })
  try {
    await until(() => f.tasks()[0]?.status === 'completed')
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['rework_authorized','accepted'])
    const business = traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role))
    expect(business.map(item => [item.role,item.round])).toEqual([['executor',0],['reviewer',0],['executor',1],['reviewer',1]])
    expect(business[2]!.prompt).toContain('补充受众依据并保留明确范围')
    expect(actionRows(f.project.id)[0]!.artifactHash).not.toBe(actionRows(f.project.id)[1]!.artifactHash)
  } finally { f.stop() }
}, 15000)

test('Given返工额度为零 WhenOwner发现缺陷 Then保留决定并明确阻断，不新增员工请求或验收', async () => {
  const f = await fixture({ rework: true, maxRework: 0 })
  try {
    await until(() => actionRows(f.project.id).length === 1)
    expect(actionRows(f.project.id)[0]!.state).toBe('blocked')
    expect(actionRows(f.project.id)[0]!.detail).toContain('额度不足')
    expect(f.tasks()[0]!.status).toBe('paused')
    expect(traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role))).toHaveLength(2)
  } finally { f.stop() }
}, 15000)

test('Given质量决定被阻断且已有旧重复观察 When处理重复结果 Then保留原阻断并继续处理后续消息', async () => {
  const f = await fixture({ rework: true, maxRework: 0 })
  try {
    await until(() => actionRows(f.project.id).length === 1)
    const original = actionRows(f.project.id)[0]!
    expect(original.state).toBe('blocked')
    // 其他任务的较新轮次不能把仍阻断的任务挤出当前风险投影。
    const db = store.getProjectDb()
    const executor = db.prepare("SELECT id FROM project_owner_execution_commands WHERE grant_id=? AND role='executor' LIMIT 1").get(f.grant.grantId) as { id: string }
    for (let i = 0; i < 13; i++) db.prepare(`INSERT INTO project_owner_execution_commands
      (id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,employee_id,role,rework_ordinal,reserved_cost_micros,state,ack_fingerprint,created_at,updated_at)
      SELECT ?,project_id,grant_id,?,?,source_step_link_id,source_version,source_hash,employee_id,'executor',0,reserved_cost_micros,'released',ack_fingerprint,?,?
      FROM project_owner_execution_commands WHERE id=?`).run(`extra-${i}`, `extra-key-${i}`, `extra-task-${i}`, Date.now() + i + 1000, Date.now() + i + 1000, executor.id)
    expect(managementConversation.getOwnerManagementConversation(f.project.id).reviewHistory?.find(round => round.businessTaskId === original.taskId)?.qualityState).toBe('blocked')
    const row = store.getProjectDb().prepare('SELECT execution_id FROM project_owner_execution_commands WHERE id=?').get(original.reviewerCommandId) as { execution_id: string }
    const observations = await import('./project-owner-management-execution')
    const { recordOwnerManagementObservation, getOwnerManager } = await import('./project-owner-management-store')
    const duplicate = observations.readOwnerExecutionObservation(f.project.id, row.execution_id, 'terminal')
    recordOwnerManagementObservation(f.project.id, goals.getProjectOwnerGoalDraft(f.project.id)!.revision, duplicate.observation, duplicate.taskId, createHash('sha256').update(randomUUID()).digest('hex'))
    await until(() => managementConversation.getOwnerManagementConversation(f.project.id).messages.some(message => message.content.includes('重复结果未应用，原阻断和恢复条件保留')))
    expect(managementConversation.getOwnerManagementConversation(f.project.id).messages.find(message => message.content.includes('重复结果未应用，原阻断和恢复条件保留'))?.kind).toBe('attention')
    expect(actionRows(f.project.id)).toEqual([original])
    expect(store.getTask(original.taskId)?.status).toBe('paused')
    scenarios.set(f.project.id, { answerBlockedQuestion: true })
    const user = sendOwnerManagementMessage({ projectId: f.project.id, conversationId: getOwnerManager(f.project.id)!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '请说明当前阻断。' })
    await until(() => Boolean(store.getProjectDb().prepare("SELECT planning_task_id FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload,'$.conversationMessageId')=?").get(f.project.id, user.id)))
    await until(() => managementConversation.getOwnerManagementConversation(f.project.id).messages.some(message => message.content === '原质量决定仍被阻断，请先核对返工额度。'))
    expect(actionRows(f.project.id)).toEqual([original])
    expect(store.getTask(original.taskId)?.status).toBe('paused')
  } finally { f.stop() }
}, 15000)

test('GivenOwner决定因任务状态变化被阻断 When任务恢复等待且准确授权仍有效 Then追加新观察和新决定并保留旧阻断', async () => {
  const f = await fixture({ hold: true })
  try {
    await until(() => pending.has(f.project.id))
    const held = pending.get(f.project.id)!
    f.stop()
    held.finish()
    await until(() => Boolean(runs.getOwnerPlanningRunOutcome(held.executionId)?.qualityDecision))
    const task = f.tasks()[0]!
    store.getProjectDb().prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(task.id)
    const first = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
    expect(first.state).toBe('blocked')
    expect(first.detail).toContain('目标、资料、计划')
    expect(store.getTask(task.id)?.status).toBe('in_progress')
    store.getProjectDb().prepare("UPDATE tasks SET status='paused' WHERE id=?").run(task.id)
    const recovery = actions.getOwnerQualityRecovery(f.project.id, first.reviewerCommandId)
    expect(recovery?.previousExecutionId).toBe(first.ownerExecutionId)
    scenarios.set(f.project.id, {})
    const execution = await import('./project-owner-management-execution')
    execution.scanOwnerExecutionObservations(f.project.id)
    const restartManagement = management.startOwnerManagementLoop()
    await until(() => actionRows(f.project.id).length === 2)
    restartManagement()
    expect(actionRows(f.project.id).map(item => item.state)).toEqual(['blocked', 'accepted'])
    expect(managementConversation.getOwnerManagementConversation(f.project.id).reviewHistory?.find(round => round.businessTaskId === task.id)?.qualityState).toBe('accepted')
    expect(actionRows(f.project.id)[1]!.ownerExecutionId).not.toBe(first.ownerExecutionId)
    expect(f.tasks()[0]!.status).toBe('completed')
    expect(traces.get(f.project.id)!.filter(item => ['executor','reviewer'].includes(item.role))).toHaveLength(2)
    expect(actions.applyOwnerQualityDecision(f.project.id, first.ownerExecutionId)).toEqual(first)
    expect(actionRows(f.project.id)).toHaveLength(2)
    expect(f.tasks()[0]!.status).toBe('completed')
  } finally { f.stop() }
}, 15000)

test('GivenOwner判断在途 When业务授权撤销后返回 Then决定保留但不能完成Task或续派', async () => {
  const f = await fixture({ hold: true, dependent: true })
  try {
    await until(() => pending.has(f.project.id))
    store.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='paused' WHERE id=?").run(f.grant.grantId)
    const held = pending.get(f.project.id)!; held.finish()
    await until(() => Boolean(runs.getOwnerPlanningRunOutcome(held.executionId)))
    const outcome = runs.getOwnerPlanningRunOutcome(held.executionId)!
    expect(outcome.state).toBe('stale')
    expect(runs.getOwnerPlanningRunReceipt(outcome.receiptId)!.responseText).toContain('quality_decision')
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(f.tasks().every(task => task.status === 'paused')).toBe(true)
  } finally { f.stop() }
}, 15000)


test('Given仅完整文本的旧业务许可 When独立评审通过 Then不自动授予Owner子任务验收', async () => {
  const f = await fixture({ legacy: true })
  try {
    await until(() => traces.get(f.project.id)!.filter(item => item.role === 'owner_analysis').length >= 2)
    expect(scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction).toBe('await_business_acceptance')
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(f.tasks()[0]!.status).toBe('paused')
  } finally { f.stop() }
}, 15000)

test('Given 旧业务许可的准确交付 When 暂缓或正式验收 Then 对话与交付链原子保存并支持同请求重试', async () => {
  const f = await fixture({ legacy: true, development: true })
  try {
    await until(() => scheduler.getOwnerAutonomousScheduleStatus(f.project.id).nextAction === 'await_business_acceptance')
    await f.stop()
    const commands = (await import('./project-owner-execution-command')).listOwnerExecutionCommands({ projectId: f.project.id })
    const executor = commands.find(command => command.role === 'executor')!
    const chainService = await import('./project-chain-service')
    const base = chainService.updateProjectChain(f.project.id, 0, { kind: 'decision', title: '修复方向', rationale: '完成修复', evidence: '测试依据' })
    const task = f.tasks()[0]!, owner = task.assignee!.userId
    const draft = chainService.updateProjectChainAsActor(f.project.id, base.revision, { kind: 'draft', taskId: task.id, title: '代码交付', content: '已修复', criteria: '验证通过', recipient: 'local-user', decisionIds: [base.decisions[0]!.id], executionId: executor.executionId!, responsibilities: { ownerId: owner, reviewerId: 'local-user', recipientId: 'local-user' } }, owner)
    const submitted = chainService.updateProjectChainAsActor(f.project.id, draft.revision, { kind: 'submit', draftId: draft.drafts[0]!.id }, owner)
    const target = submitted.drafts[0]!, status = scheduler.getOwnerAutonomousScheduleStatus(f.project.id)
    const service = await import('./project-owner-chain-decision')
    const request = { projectId: f.project.id, requestId: randomUUID(), grantId: f.grant.grantId, taskId: task.id, reworkOrdinal: status.reworkOrdinal!, revision: submitted.revision, draftId: target.id, version: target.version, choice: 'later' as const, comment: '', completedCriteria: [] }
    expect(service.decideOwnerChainDelivery(request).revision).toBe(submitted.revision)
    expect(service.decideOwnerChainDelivery(request).revision).toBe(submitted.revision)
    const laterMessages = managementConversation.getOwnerManagementConversation(f.project.id).messages.filter(message => message.chainReview?.requestHash && message.chainReview.choice === 'later')
    expect(laterMessages).toHaveLength(1)
    const pendingConversation = await import('./project-owner-management-conversation')
    pendingConversation.hasUnstartedOwnerConversation(f.project.id)
    pendingConversation.preparePendingOwnerConversation(f.project.id)
    expect(store.getProjectDb().prepare("SELECT COUNT(*) AS n FROM project_owner_planning_links WHERE project_id=? AND json_extract(payload, '$.conversationMessageId')=?").get(f.project.id, laterMessages[0]!.id)).toEqual({ n: 0 })
    expect(() => service.decideOwnerChainDelivery({ ...request, choice: 'accept', comment: '核对通过' })).toThrow('不同决定')
    const acceptance = { ...request, requestId: randomUUID(), choice: 'accept' as const, comment: '逐项核对通过', completedCriteria: target.definitionOfDone }
    expect(() => service.decideOwnerChainDelivery({ ...acceptance, version: target.version + 1 })).toThrow('交付版本')
    store.getProjectDb().prepare("CREATE TRIGGER owner_test_record_failure BEFORE INSERT ON project_owner_management_messages WHEN json_extract(NEW.payload, '$.chainReview.choice') = 'accept' BEGIN SELECT RAISE(ABORT, '模拟对话写入失败'); END").run()
    expect(() => service.decideOwnerChainDelivery(acceptance)).toThrow('模拟对话写入失败')
    store.getProjectDb().prepare('DROP TRIGGER owner_test_record_failure').run()
    expect(chainService.getProjectChain(f.project.id).revision).toBe(submitted.revision)
    expect(chainService.getProjectChain(f.project.id).drafts[0]!.status).toBe('submitted')
    const accepted = service.decideOwnerChainDelivery(acceptance)
    expect(accepted.drafts[0]!.status).toBe('accepted')
    expect(service.decideOwnerChainDelivery(acceptance).revision).toBe(accepted.revision)
    expect(managementConversation.getOwnerManagementConversation(f.project.id).messages.filter(message => message.chainReview?.choice === 'accept')).toHaveLength(1)
  } finally { await f.stop() }
}, 30000)

test('Given准确Reviewer成果 WhenOwner判定协议或内部返工入口被篡改 Then拒绝错版本、虚构依据与无决定续派', async () => {
  const f = await fixture({ hold: true })
  try {
    await until(() => pending.has(f.project.id))
    const held = pending.get(f.project.id)!, execution = store.getAgentExecution(held.executionId)!
    const snapshot = source.readOwnerPlanningSnapshot(execution.entityId)!, context = snapshot.context, delivery = context.conversation!.deliveryReview!
    const decision = { reviewerCommandId: delivery.review!.reviewerCommandId, artifactHash: delivery.artifact!.contentSha256, verdict: 'accept', reason: '根据完整正文核对', criteria: [{ criterion: '明确目标范围与受众依据', status: 'met', evidence: '逐项检查', quote: '目标范围' }], findings: [] }
    const { parseOwnerQualityDecision } = await import('./project-owner-quality-protocol')
    expect(parseOwnerQualityDecision(decision, context).verdict).toBe('accept')
    for (const patch of [{ artifactHash: '0'.repeat(64) }, { reviewerCommandId: randomUUID() }, { criteria: [{ ...decision.criteria[0], quote: '正文不存在的引用' }] }, { criteria: [{ ...decision.criteria[0], status: 'not_verified', quote: null }] }, { criteria: [] }]) expect(() => parseOwnerQualityDecision({ ...decision, ...patch }, context)).toThrow()
    const old = structuredClone(context); delete old.conversation!.deliveryReview!.qualityDecisionVersion
    expect(() => parseOwnerQualityDecision(decision, old)).toThrow('缺少')
    const outdated = structuredClone(context); outdated.conversation!.currentPlan!.revision++
    expect(() => parseOwnerQualityDecision(decision, outdated)).toThrow('当前方案')
    expect(() => (require('./project-owner-execution-command') as typeof import('./project-owner-execution-command')).reserveAndQueueAutonomousOwnerCommand({ projectId: f.project.id }, { grantId: f.grant.grantId, taskId: f.tasks()[0]!.id, role: 'executor', reworkOrdinal: 1, expectedRevalidationRevision: f.grant.revalidationRevision })).toThrow('返工前置')
    held.finish(); await until(() => actionRows(f.project.id).length === 1)
  } finally { f.stop() }
}, 15000)


test('GivenOwner决定已保存且未投影 When数据库重开并重放 Then只完成一次Task并保留Owner身份审计', async () => {
  const f = await fixture({ hold: true })
  await until(() => pending.has(f.project.id)); f.stop()
  const held = pending.get(f.project.id)!; held.finish()
  expect(runs.getOwnerPlanningRunOutcome(held.executionId)?.qualityDecision?.verdict).toBe('accept')
  expect(actionRows(f.project.id)).toHaveLength(0)
  store.closeProjectDb(); await store.initProjectDb()
  const action = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
  expect(action.state).toBe('accepted')
  expect(f.tasks()[0]!.status).toBe('completed')
  expect(actions.applyOwnerQualityDecision(f.project.id, held.executionId)).toEqual(action)
  expect((store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_activities WHERE project_id=? AND action='owner_quality_decision'").get(f.project.id) as { count: number }).count).toBe(1)
  expect(() => store.getProjectDb().prepare("UPDATE project_owner_quality_actions SET task_id='changed' WHERE reviewer_command_id=?").run(action.reviewerCommandId)).toThrow('immutable')
}, 15000)

test('GivenTask更新后活动写入故障 When执行Owner验收 ThenSAVEPOINT回滚Task，保留阻断而非半验收', async () => {
  const f = await fixture({ hold: true })
  await until(() => pending.has(f.project.id)); f.stop()
  const held = pending.get(f.project.id)!; held.finish()
  store.getProjectDb().exec("CREATE TRIGGER owner_quality_fail_activity BEFORE INSERT ON project_activities WHEN NEW.action='updated' BEGIN SELECT RAISE(ABORT,'合成活动写入故障'); END")
  try {
    const action = actions.applyOwnerQualityDecision(f.project.id, held.executionId)
    expect(action.state).toBe('blocked')
    expect(action.detail).toContain('合成活动写入故障')
    expect(f.tasks()[0]!.status).toBe('paused')
    expect(f.tasks()[0]!.completionNotes).toBeFalsy()
    expect(actionRows(f.project.id)).toHaveLength(1)
  } finally { store.getProjectDb().exec('DROP TRIGGER IF EXISTS owner_quality_fail_activity') }
}, 15000)

for (const compatibility of [
  { name: '缺kind', scenario: { omitQualityKind: true }, detail: 'Owner执行跟进只允许分析回应或必要协商' },
  { name: '附加已满足项目标准', scenario: { extraQualityCriteria: true }, detail: 'Owner质量决定与准确评审/成果不匹配' },
  { name: '代码引用容器误判', scenario: { development: true }, detail: 'Owner质量决定未按准确标准逐项判断或引用不符' },
] as Array<{ name: string; scenario: Scenario; detail: string }>) test(`Given旧版本将${compatibility.name}质量决定拒绝 When本地重验完整原文 Then追加恢复记录并保持原失败和调用次数`, async () => {
  const f = await fixture(compatibility.scenario)
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const action = actionRows(f.project.id)[0]!
    const outcome = runs.getOwnerPlanningRunOutcome(action.ownerExecutionId)!
    const before = traces.get(f.project.id)!.length
    // 仅在隔离测试库重建旧解析器的分类；原始回执与正文不变。
    const failed = { executionId: outcome.executionId, receiptId: outcome.receiptId, state: 'failed', detail: compatibility.detail }
    const integrityHash = createHash('sha256').update(JSON.stringify(failed)).digest('hex')
    store.getProjectDb().prepare('UPDATE project_owner_planning_run_outcomes SET payload=? WHERE execution_id=?').run(JSON.stringify({ ...failed, integrityHash }), outcome.executionId)
    expect(runs.recoverLegacyOwnerConversationReply(outcome.executionId)).toMatchObject({ state: 'replied', qualityDecision: { verdict: 'accept' } })
    const originalText = runs.getOwnerPlanningRunReceipt(outcome.receiptId)!.responseText
    if (compatibility.scenario.omitQualityKind) expect(originalText).not.toContain('"kind"')
    else expect(JSON.parse(originalText).decision.criteria).toHaveLength(compatibility.scenario.extraQualityCriteria ? 2 : 1)
    expect(runs.getOwnerPlanningRunOutcome(outcome.executionId)?.qualityDecision?.criteria).toHaveLength(1)
    expect(store.getProjectDb().prepare("SELECT json_extract(payload, '$.state') AS state FROM project_owner_planning_run_outcomes WHERE execution_id=?").get(outcome.executionId)).toEqual({ state: 'failed' })
    expect(actions.applyOwnerQualityDecision(f.project.id, outcome.executionId)).toEqual(action)
    expect(runs.recoverLegacyOwnerConversationReply(outcome.executionId)).toMatchObject({ state: 'replied' })
    expect(traces.get(f.project.id)).toHaveLength(before)
  } finally { f.stop() }
}, 15000)

test('Given验证缺口的Owner原判断被旧协议拒绝 When重验原回执 Then保留阻断并且不重派或验收', async () => {
  const f = await fixture({ hold: true, development: true, evidenceGap: true })
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    f.stop()
    const held = pending.get(f.project.id)!
    held.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(held.executionId)?.state === 'replied', f.project.id)
    const outcome = runs.getOwnerPlanningRunOutcome(held.executionId)!
    const failed = { executionId: outcome.executionId, receiptId: outcome.receiptId, state: 'failed', detail: 'Owner返工必须指出具体不满足标准及可执行修改' }
    const integrityHash = createHash('sha256').update(JSON.stringify(failed)).digest('hex')
    store.getProjectDb().prepare('UPDATE project_owner_planning_run_outcomes SET payload=? WHERE execution_id=?').run(JSON.stringify({ ...failed, integrityHash }), outcome.executionId)
    const count = traces.get(f.project.id)!.length
    expect(runs.recoverLegacyOwnerConversationReply(outcome.executionId)?.qualityDecision?.verdict).toBe('rework')
    const action = actions.applyOwnerQualityDecision(f.project.id, outcome.executionId)
    expect(action.state).toBe('blocked')
    expect(action.detail).toContain('缺少运行验证证据')
    expect(f.tasks()[0]!.status).toBe('paused')
    expect(traces.get(f.project.id)).toHaveLength(count)
    expect(store.getProjectDb().prepare("SELECT json_extract(payload, '$.state') AS state FROM project_owner_planning_run_outcomes WHERE execution_id=?").get(outcome.executionId)).toEqual({ state: 'failed' })
  } finally { f.stop() }
}, 30000)


test('Given独立评审回调返回空文本 When收尾 Then持久说明无有效评审且不验收交付', async () => {
  const f = await fixture({ emptyReview: true })
  try {
    const records = await import('./project-owner-management-store')
    await until(() => records.getOwnerManagementView(f.project.id).messages.some(message => message.eventId.startsWith('owner-review-evidence-rejected:')), f.project.id)
    expect((await import('./project-owner-technical-review')).listOwnerTechnicalReviewEvidence(f.project.id)).toHaveLength(0)
    expect(actionRows(f.project.id)).toHaveLength(0)
    expect(records.getOwnerManagementView(f.project.id).messages.some(message => message.kind === 'delivery')).toBe(false)
    expect(store.listAgentExecutionsByProject(f.project.id).some(execution => execution.ownerCommandId && execution.status === 'completed')).toBe(true)
  } finally { f.stop() }
}, 15000)


test('Given已恢复的accept尚未执行而验证随后过期 When首次应用 Then历史仍可读但动作阻断且任务不完成', async () => {
  const f = await fixture({ hold: true, development: true })
  try {
    await until(() => pending.has(f.project.id), f.project.id); f.stop()
    const held = pending.get(f.project.id)!
    held.finish()
    const outcome = runs.getOwnerPlanningRunOutcome(held.executionId)!
    expect(outcome.qualityDecision?.verdict).toBe('accept')
    const failed = { executionId: outcome.executionId, receiptId: outcome.receiptId, state: 'failed', detail: 'Owner质量决定未按准确标准逐项判断或引用不符' }
    const integrityHash = createHash('sha256').update(JSON.stringify(failed)).digest('hex')
    store.getProjectDb().prepare('UPDATE project_owner_planning_run_outcomes SET payload=? WHERE execution_id=?').run(JSON.stringify({ ...failed, integrityHash }), outcome.executionId)
    expect(runs.recoverLegacyOwnerConversationReply(outcome.executionId)?.qualityDecision?.verdict).toBe('accept')
    const later = Date.now() + 31 * 60_000, clock = spyOn(Date, 'now').mockReturnValue(later)
    try {
      expect(runs.getOwnerPlanningRunOutcome(outcome.executionId)?.qualityDecision?.verdict).toBe('accept')
      const action = actions.applyOwnerQualityDecision(f.project.id, outcome.executionId)
      expect(action.state).toBe('blocked')
      expect(action.detail).toContain('不能在独立检查未通过')
      expect(f.tasks()[0]!.status).toBe('paused')
    } finally { clock.mockRestore() }
  } finally { f.stop() }
}, 15000)


test('Given Owner质量引用被协议拒绝且历史提示已升级 When烟测显式恢复原失败 Then只新增一次判断并保留追溯且不自动重试', async () => {
  const f = await fixture({ hold: true, invalidQualityQuote: true })
  const savedSmoke = process.env.GRAVITAS_PACKAGE_SMOKE, savedRecovery = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
  let restartManagement: (() => void) | undefined
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const held = pending.get(f.project.id)!
    f.stop(); held.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(held.executionId)?.state === 'failed', f.project.id)
    expect(actionRows(f.project.id)).toHaveLength(0)
    const planningTaskId = store.getAgentExecution(held.executionId)!.entityId
    const linkRow = store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_links WHERE planning_task_id=?').get(planningTaskId) as { payload: string }
    const historicalPayload = JSON.parse(linkRow.payload) as Record<string, unknown>
    historicalPayload.promptHash = 'f'.repeat(64)
    store.getProjectDb().prepare('UPDATE project_owner_planning_links SET payload=? WHERE planning_task_id=?').run(JSON.stringify(historicalPayload), planningTaskId)
    expect(() => source.readOwnerPlanningSnapshot(planningTaskId)).toThrow('Owner规划来源记录无效')
    const snapshot = source.readOwnerPlanningSnapshot(planningTaskId, { allowUnknownPromptForHistory: true })!
    const reviewerCommandId = snapshot.context.conversation!.executionObservation!.commandId
    expect(actions.getOwnerQualityRecovery(f.project.id, reviewerCommandId)).toBeNull()
    process.env.GRAVITAS_PACKAGE_SMOKE = '1'
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = held.executionId
    expect(actions.getOwnerQualityRecovery(f.project.id, reviewerCommandId)?.previousExecutionId).toBe(held.executionId)
    scenarios.set(f.project.id, {})
    const recoverySmoke = await import('./owner-quality-protocol-recovery-smoke')
    recoverySmoke.resumeFailedOwnerQualityForSmoke(f.project.id, held.executionId)
    restartManagement = management.startOwnerManagementLoop()
    await until(() => actionRows(f.project.id).length === 1, f.project.id)
    const action = actionRows(f.project.id)[0]!
    expect(action.state).toBe('accepted')
    expect(action.recoveredFromOwnerExecutionId).toBe(held.executionId)
    expect(runs.getOwnerPlanningRunOutcome(held.executionId)?.state).toBe('failed')
    expect(traces.get(f.project.id)!.filter(item => ['executor', 'reviewer'].includes(item.role))).toHaveLength(2)
    expect(traces.get(f.project.id)!.filter(item => item.role === 'owner_quality')).toHaveLength(2)
    expect(() => recoverySmoke.resumeFailedOwnerQualityForSmoke(f.project.id, held.executionId)).toThrow('不允许恢复')
  } finally {
    restartManagement?.(); f.stop()
    if (savedSmoke === undefined) delete process.env.GRAVITAS_PACKAGE_SMOKE
    else process.env.GRAVITAS_PACKAGE_SMOKE = savedSmoke
    if (savedRecovery === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = savedRecovery
  }
}, 15000)


test('Given质量协议失败且准备与委托均到期 When按原额度及新增预算续期 Then追加继任再验证且原授权账本与员工次数不变', async () => {
  const f = await fixture({ hold: true, invalidQualityQuote: true })
  const savedSmoke = process.env.GRAVITAS_PACKAGE_SMOKE, savedRecovery = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID, savedMaxRequests = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS
  const savedMaxCost = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS, savedDuration = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RENEWAL_DURATION_MS
  let restartManagement: (() => void) | undefined, clock: ReturnType<typeof spyOn> | undefined
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const held = pending.get(f.project.id)!
    f.stop(); held.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(held.executionId)?.state === 'failed', f.project.id)
    const planningTaskId = store.getAgentExecution(held.executionId)!.entityId
    const snapshot = source.readOwnerPlanningSnapshot(planningTaskId)!
    const reviewerCommandId = snapshot.context.conversation!.executionObservation!.commandId
    const revalidation = await import('./project-owner-execution-revalidation')
    const settlement = await import('./project-owner-execution-settlement')
    const original = revalidation.listOwnerExecutionRevalidationHistory({ projectId: f.project.id })[0]!
    const originalPayload = store.getProjectDb().prepare('SELECT payload,integrity_hash FROM project_owner_execution_revalidations WHERE id=?').get(original.id)
    const originalUsage = settlement.readOwnerGrantUsage(f.grant.grantId)
    const originalCommandCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count
    const originalDelegation = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    process.env.GRAVITAS_PACKAGE_SMOKE = '1'
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = held.executionId
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = String(originalDelegation.maxRequests - 1)
    clock = spyOn(Date, 'now').mockReturnValue(Math.max(f.input.expiresAt, originalDelegation.expiresAt) + 1000)
    const recoverySmoke = await import('./owner-quality-protocol-recovery-smoke')
    expect(() => recoverySmoke.renewExpiredOwnerQualityAuthorizationForSmoke(f.project.id, held.executionId)).toThrow('不得低于原额度')
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = String(originalDelegation.maxRequests)
    recoverySmoke.renewExpiredOwnerQualityAuthorizationForSmoke(f.project.id, held.executionId)
    const renewed = revalidation.getOwnerExecutionRevalidation({ projectId: f.project.id })
    expect(renewed.status).toBe('current')
    expect(renewed.revalidation?.id).not.toBe(original.id)
    expect(renewed.revalidation?.previousIntegrityHash).toBe(original.integrityHash)
    expect(renewed.revalidation?.source.budget).toMatchObject({ maxCostMicros: f.input.maxCostMicros, maxRuns: f.input.maxRuns, maxRework: f.input.maxRework })
    expect(store.getProjectDb().prepare('SELECT payload,integrity_hash FROM project_owner_execution_revalidations WHERE id=?').get(original.id)).toEqual(originalPayload)
    const grant = executionGrants.getOwnerExecutionGrant({ projectId: f.project.id })!
    expect(grant.grantId).toBe(f.grant.grantId)
    expect(grant.revalidationId).toBe(renewed.revalidation!.id)
    expect(grant.budget).toMatchObject({ maxCostMicros: f.input.maxCostMicros, maxRuns: f.input.maxRuns, maxRework: f.input.maxRework, expiresAt: renewed.revalidation!.source.budget.expiresAt })
    expect(settlement.readOwnerGrantUsage(f.grant.grantId)).toEqual(originalUsage)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count).toBe(originalCommandCount)
    expect(actions.getOwnerQualityRecovery(f.project.id, reviewerCommandId)?.previousExecutionId).toBe(held.executionId)
    const revalidationCount = revalidation.listOwnerExecutionRevalidationHistory({ projectId: f.project.id }).length
    const delegationCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_delegations WHERE project_id=?').get(f.project.id) as { count: number }).count
    const renewalActivityCount = (store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_activities WHERE project_id=? AND action='owner_quality_smoke_renewed'").get(f.project.id) as { count: number }).count
    recoverySmoke.renewExpiredOwnerQualityAuthorizationForSmoke(f.project.id, held.executionId)
    expect(revalidation.listOwnerExecutionRevalidationHistory({ projectId: f.project.id })).toHaveLength(revalidationCount)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_delegations WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(delegationCount)
    expect((store.getProjectDb().prepare("SELECT COUNT(*) AS count FROM project_activities WHERE project_id=? AND action='owner_quality_smoke_renewed'").get(f.project.id) as { count: number }).count).toBe(renewalActivityCount)
    const firstDelegation = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS = String(firstDelegation.maxCostMicros + 650000)
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RENEWAL_DURATION_MS = '7200000'
    clock.mockReturnValue(firstDelegation.expiresAt + 1000)
    recoverySmoke.renewExpiredOwnerQualityAuthorizationForSmoke(f.project.id, held.executionId)
    const increased = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    expect(increased.maxCostMicros).toBe(firstDelegation.maxCostMicros + 650000)
    expect(increased.expiresAt).toBe(firstDelegation.expiresAt + 1000 + 7200000)
    expect(executionGrants.getOwnerExecutionGrant({ projectId: f.project.id })!.budget).toMatchObject({ maxCostMicros: f.input.maxCostMicros, maxRuns: f.input.maxRuns, maxRework: f.input.maxRework })
    expect(settlement.readOwnerGrantUsage(f.grant.grantId)).toEqual(originalUsage)
    clock.mockRestore(); clock = undefined
    scenarios.set(f.project.id, {})
    recoverySmoke.resumeFailedOwnerQualityForSmoke(f.project.id, held.executionId)
    restartManagement = management.startOwnerManagementLoop()
    await until(() => actionRows(f.project.id).length === 1, f.project.id)
    expect(actionRows(f.project.id)[0]).toMatchObject({ state: 'accepted', recoveredFromOwnerExecutionId: held.executionId })
    expect(traces.get(f.project.id)!.filter(item => ['executor', 'reviewer'].includes(item.role))).toHaveLength(originalCommandCount)
  } finally {
    clock?.mockRestore(); restartManagement?.(); f.stop()
    if (savedSmoke === undefined) delete process.env.GRAVITAS_PACKAGE_SMOKE
    else process.env.GRAVITAS_PACKAGE_SMOKE = savedSmoke
    if (savedRecovery === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = savedRecovery
    if (savedMaxRequests === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = savedMaxRequests
    if (savedMaxCost === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS = savedMaxCost
    if (savedDuration === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RENEWAL_DURATION_MS
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RENEWAL_DURATION_MS = savedDuration
  }
}, 20000)


test('Given验证过期导致准确质量失败且请求用量完整 When明确授权原成果复验 Then只追加同期限同额度委托且可幂等恢复', async () => {
  const f = await fixture({ development: true, hold: true })
  const savedSmoke = process.env.GRAVITAS_PACKAGE_SMOKE, savedRecovery = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
  const savedHash = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH, savedMaxRequests = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS, savedMaxCost = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS
  let clock: ReturnType<typeof spyOn> | undefined
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const held = pending.get(f.project.id)!
    f.stop()
    clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000)
    held.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(held.executionId)?.state === 'failed', f.project.id)
    clock.mockRestore(); clock = undefined
    const originalOutcome = runs.getOwnerPlanningRunOutcome(held.executionId)
    expect(originalOutcome?.detail).toBe('Owner不能在独立检查未通过或标准未满足时接受成果')
    const previous = delegation.getOwnerManagementDelegation(f.project.id)
    // 协议拒绝不再把项目永久冻结在 attention：委托保持可接续，原失败记录与预留照旧保留。
    expect(previous).toMatchObject({ state: 'active' })
    expect(runs.getOwnerPlanningRunOutcome(held.executionId)).toMatchObject({ state: 'failed', protocolRejected: true })
    const planningTaskId = store.getAgentExecution(held.executionId)!.entityId
    const snapshot = source.readOwnerPlanningSnapshot(planningTaskId)!
    const artifactHash = snapshot.context.conversation!.deliveryReview!.developmentArtifact!.contentHash
    const originalGrant = executionGrants.getOwnerExecutionGrant({ projectId: f.project.id })!
    const settlement = await import('./project-owner-execution-settlement')
    const originalUsage = settlement.readOwnerGrantUsage(f.grant.grantId)
    const originalCommandCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count
    process.env.GRAVITAS_PACKAGE_SMOKE = '1'
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = held.executionId
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH = artifactHash
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = String(previous.delegation!.maxRequests)
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS = String(previous.delegation!.maxCostMicros)
    const recoverySmoke = await import('./owner-quality-protocol-recovery-smoke')
    recoverySmoke.authorizeOwnerQualityRevalidationFromFailedRun(f.project.id, held.executionId, artifactHash)
    const renewed = delegation.getOwnerManagementDelegation(f.project.id)
    expect(renewed).toMatchObject({ state: 'active', delegation: { maxRequests: previous.delegation!.maxRequests, maxCostMicros: previous.delegation!.maxCostMicros, expiresAt: previous.delegation!.expiresAt } })
    // 委托在协议拒绝后仍可接续，复验走 reusable 分支复用原委托，不重复签发消耗额度。
    expect(renewed.delegation!.id).toBe(previous.delegation!.id)
    const migratedGrant = executionGrants.getOwnerExecutionGrant({ projectId: f.project.id })!
    expect(migratedGrant).toMatchObject({ grantId: originalGrant.grantId, revalidationId: originalGrant.revalidationId, revalidationRevision: originalGrant.revalidationRevision, ownerManagementDelegationId: renewed.delegation!.id })
    expect(migratedGrant.budget.expiresAt).toBe(originalGrant.budget.expiresAt)
    expect(settlement.readOwnerGrantUsage(f.grant.grantId)).toEqual(originalUsage)
    expect(runs.getOwnerPlanningRunOutcome(held.executionId)).toEqual(originalOutcome)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count).toBe(originalCommandCount)
    const delegationCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_delegations WHERE project_id=?').get(f.project.id) as { count: number }).count
    recoverySmoke.authorizeOwnerQualityRevalidationFromFailedRun(f.project.id, held.executionId, artifactHash)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_delegations WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(delegationCount)
    expect(() => recoverySmoke.authorizeOwnerQualityRevalidationFromFailedRun(f.project.id, held.executionId, '0'.repeat(64))).toThrow('准确成果哈希')
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_delegations WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(delegationCount)
  } finally {
    clock?.mockRestore(); f.stop()
    for (const [key, value] of Object.entries({ GRAVITAS_PACKAGE_SMOKE: savedSmoke, GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID: savedRecovery, GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH: savedHash, GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS: savedMaxRequests, GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS: savedMaxCost })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 20000)


test('Given原成果复验许可与两项授权均已到期且同身份渠道配置已刷新 When明确续期复验 Then追加配置确认与继任许可且历史账本不变', async () => {
  const f = await fixture({ development: true, hold: true })
  const savedSmoke = process.env.GRAVITAS_PACKAGE_SMOKE, savedRecovery = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
  const savedHash = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH, savedMaxRequests = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS, savedMaxCost = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS
  let clock: ReturnType<typeof spyOn> | undefined
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const held = pending.get(f.project.id)!
    f.stop()
    clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000)
    held.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(held.executionId)?.state === 'failed', f.project.id)
    clock.mockRestore(); clock = undefined
    const originalOutcome = runs.getOwnerPlanningRunOutcome(held.executionId)
    const planningTaskId = store.getAgentExecution(held.executionId)!.entityId
    const snapshot = source.readOwnerPlanningSnapshot(planningTaskId)!
    const artifactHash = snapshot.context.conversation!.deliveryReview!.developmentArtifact!.contentHash
    const previous = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    process.env.GRAVITAS_PACKAGE_SMOKE = '1'
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = held.executionId
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH = artifactHash
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = String(previous.maxRequests)
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS = String(previous.maxCostMicros)
    const recoverySmoke = await import('./owner-quality-protocol-recovery-smoke')
    recoverySmoke.authorizeOwnerQualityRevalidationFromFailedRun(f.project.id, held.executionId, artifactHash)
    const firstGrant = executionGrants.getOwnerExecutionGrant({ projectId: f.project.id })!
    const firstDelegation = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    const settlement = await import('./project-owner-execution-settlement')
    const originalUsage = settlement.readOwnerGrantUsage(f.grant.grantId)
    const originalCommandCount = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count
    const permitRows = () => store.getProjectDb().prepare("SELECT payload FROM project_activities WHERE project_id=? AND action='owner_quality_revalidation_smoke_authorized' ORDER BY rowid").all(f.project.id) as Array<{ payload: string }>
    const firstPermit = permitRows()[0]!
    const staleBinding = binding.getOwnerRuntimeBinding(f.project.id)!
    // 真实配置漂移（服务地址变化）；仅改显示名不应触发重新绑定。
    channels.updateChannel(staleBinding.channelId, { baseUrl: 'https://changed.invalid/v1' })
    clock = spyOn(Date, 'now').mockReturnValue(Math.max(firstDelegation.expiresAt, firstGrant.budget.expiresAt) + 1000)
    recoverySmoke.authorizeOwnerQualityRevalidationFromFailedRun(f.project.id, held.executionId, artifactHash)
    const renewed = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    const migratedGrant = executionGrants.getOwnerExecutionGrant({ projectId: f.project.id })!
    const refreshedBinding = binding.getOwnerRuntimeBinding(f.project.id)!
    expect(refreshedBinding).toMatchObject({ revision: staleBinding.revision + 1, carrierId: staleBinding.carrierId, workspaceId: staleBinding.workspaceId, channelId: staleBinding.channelId, modelId: staleBinding.modelId, actor: 'local-user' })
    const revalidationHistory = (await import('./project-owner-execution-revalidation')).listOwnerExecutionRevalidationHistory({ projectId: f.project.id })
    expect(revalidationHistory.at(-1)?.source.channelHash).not.toBe(revalidationHistory.at(-2)?.source.channelHash)
    expect(revalidationHistory.at(-1)?.source.ownerBindingProvenance).toMatchObject({ state: 'bound', bindingRevision: refreshedBinding.revision, carrierId: staleBinding.carrierId })
    expect(renewed.id).not.toBe(firstDelegation.id)
    expect(renewed).toMatchObject({ maxRequests: firstDelegation.maxRequests, maxCostMicros: firstDelegation.maxCostMicros, expiresAt: Date.now() + 3600_000 })
    expect(migratedGrant.revalidationRevision).toBe(firstGrant.revalidationRevision + 1)
    expect(migratedGrant.budget.expiresAt).toBe(renewed.expiresAt)
    const permits = permitRows()
    expect(permits).toHaveLength(2)
    expect(permits[0]).toEqual(firstPermit)
    expect(JSON.parse(permits[1]!.payload)).toMatchObject({ artifactHash, revalidationId: migratedGrant.revalidationId, revalidationRevision: migratedGrant.revalidationRevision })
    expect(settlement.readOwnerGrantUsage(f.grant.grantId)).toEqual(originalUsage)
    expect(runs.getOwnerPlanningRunOutcome(held.executionId)).toEqual(originalOutcome)
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=?').get(f.grant.grantId) as { count: number }).count).toBe(originalCommandCount)
    recoverySmoke.authorizeOwnerQualityRevalidationFromFailedRun(f.project.id, held.executionId, artifactHash)
    expect(permitRows()).toHaveLength(2)
    expect(() => recoverySmoke.authorizeOwnerQualityRevalidationFromFailedRun(f.project.id, held.executionId, '0'.repeat(64))).toThrow('准确成果哈希')
    expect(permitRows()).toHaveLength(2)
  } finally {
    clock?.mockRestore(); f.stop()
    for (const [key, value] of Object.entries({ GRAVITAS_PACKAGE_SMOKE: savedSmoke, GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID: savedRecovery, GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH: savedHash, GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS: savedMaxRequests, GRAVITAS_OWNER_CHAIN_SMOKE_MAX_COST_MICROS: savedMaxCost })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 20000)


test('Given恢复请求因本地硬上限未发送且委托未到期 When用户明确续期 Then保留账本并允许再次恢复', async () => {
  const f = await fixture({ hold: true, invalidQualityQuote: true })
  const savedSmoke = process.env.GRAVITAS_PACKAGE_SMOKE, savedRecovery = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID, savedMaxRequests = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS
  let restartManagement: (() => void) | undefined
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const original = pending.get(f.project.id)!
    f.stop(); original.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(original.executionId)?.state === 'failed', f.project.id)
    process.env.GRAVITAS_PACKAGE_SMOKE = '1'
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = original.executionId
    const recoverySmoke = await import('./owner-quality-protocol-recovery-smoke')
    scenarios.set(f.project.id, { localConfigurationError: 'No output generated. Check the stream for errors.；流错误：Error: 真实冒烟请求次数边界无效', localConfigurationRuntimeResult: true })
    recoverySmoke.resumeFailedOwnerQualityForSmoke(f.project.id, original.executionId)
    restartManagement = management.startOwnerManagementLoop()
    await until(() => store.listAgentExecutionsByProject(f.project.id).some(item => item.id !== original.executionId && item.status === 'failed'), f.project.id)
    restartManagement(); restartManagement = undefined
    const localFailure = store.listAgentExecutionsByProject(f.project.id).find(item => item.id !== original.executionId && item.status === 'failed')!
    const previous = delegation.getOwnerManagementDelegation(f.project.id)
    expect(previous).toMatchObject({ state: 'stale', detail: expect.stringContaining('未进入模型请求发送') })
    expect(previous.delegation!.expiresAt).toBeGreaterThan(Date.now())
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_planning_admissions WHERE execution_id=?').get(localFailure.id)).toEqual({ count: 0 })
    const settlement = await import('./project-owner-execution-settlement')
    const originalUsage = settlement.readOwnerGrantUsage(f.grant.grantId)
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = String(previous.delegation!.maxRequests - 1)
    expect(() => recoverySmoke.renewExpiredOwnerQualityAuthorizationForSmoke(f.project.id, original.executionId)).toThrow('不得低于原额度')
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = String(previous.delegation!.maxRequests)
    recoverySmoke.renewExpiredOwnerQualityAuthorizationForSmoke(f.project.id, original.executionId)
    const renewed = delegation.getOwnerManagementDelegation(f.project.id)
    expect(renewed).toMatchObject({ state: 'active', delegation: { maxRequests: previous.delegation!.maxRequests, maxCostMicros: previous.delegation!.maxCostMicros } })
    expect(renewed.delegation!.id).not.toBe(previous.delegation!.id)
    expect(settlement.readOwnerGrantUsage(f.grant.grantId)).toEqual(originalUsage)
    scenarios.set(f.project.id, {})
    recoverySmoke.resumeFailedOwnerQualityForSmoke(f.project.id, original.executionId)
    restartManagement = management.startOwnerManagementLoop()
    await until(() => actionRows(f.project.id).length === 1, f.project.id)
    expect(actionRows(f.project.id)[0]).toMatchObject({ state: 'accepted', recoveredFromOwnerExecutionId: original.executionId })
    expect(store.getAgentExecution(localFailure.id)?.status).toBe('failed')
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_planning_admissions WHERE execution_id=?').get(localFailure.id)).toEqual({ count: 0 })
  } finally {
    restartManagement?.(); f.stop()
    if (savedSmoke === undefined) delete process.env.GRAVITAS_PACKAGE_SMOKE
    else process.env.GRAVITAS_PACKAGE_SMOKE = savedSmoke
    if (savedRecovery === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = savedRecovery
    if (savedMaxRequests === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = savedMaxRequests
  }
}, 20000)


test('Given相同本地错误但运行回执含非零用量 When请求续期 Then保持未知门禁且不发行继任委托', async () => {
  const f = await fixture({ hold: true, invalidQualityQuote: true })
  const savedSmoke = process.env.GRAVITAS_PACKAGE_SMOKE, savedRecovery = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID, savedMaxRequests = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS
  let restartManagement: (() => void) | undefined
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const original = pending.get(f.project.id)!
    f.stop(); original.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(original.executionId)?.state === 'failed', f.project.id)
    process.env.GRAVITAS_PACKAGE_SMOKE = '1'
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = original.executionId
    const current = delegation.getOwnerManagementDelegation(f.project.id).delegation!
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = String(current.maxRequests)
    scenarios.set(f.project.id, { localConfigurationError: 'No output generated. Check the stream for errors.；流错误：Error: 真实冒烟请求次数边界无效', localConfigurationRuntimeResult: true, localConfigurationNonZeroUsage: true })
    const recoverySmoke = await import('./owner-quality-protocol-recovery-smoke')
    recoverySmoke.resumeFailedOwnerQualityForSmoke(f.project.id, original.executionId)
    restartManagement = management.startOwnerManagementLoop()
    await until(() => store.listAgentExecutionsByProject(f.project.id).some(item => item.id !== original.executionId && item.status === 'failed'), f.project.id)
    restartManagement(); restartManagement = undefined
    expect(delegation.getOwnerManagementDelegation(f.project.id).state).toBe('attention')
    const count = (store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_delegations WHERE project_id=?').get(f.project.id) as { count: number }).count
    expect(() => recoverySmoke.renewExpiredOwnerQualityAuthorizationForSmoke(f.project.id, original.executionId)).toThrow('已到期')
    expect((store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_management_delegations WHERE project_id=?').get(f.project.id) as { count: number }).count).toBe(count)
  } finally {
    restartManagement?.(); f.stop()
    if (savedSmoke === undefined) delete process.env.GRAVITAS_PACKAGE_SMOKE
    else process.env.GRAVITAS_PACKAGE_SMOKE = savedSmoke
    if (savedRecovery === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = savedRecovery
    if (savedMaxRequests === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = savedMaxRequests
  }
}, 20000)


test('Given质量恢复请求已在途且恢复入口随管理状态关闭 When重放冻结来源 Then恢复提示不漂移且权限仍由门禁拒绝', async () => {
  const f = await fixture({ hold: true, invalidQualityQuote: true })
  const savedSmoke = process.env.GRAVITAS_PACKAGE_SMOKE, savedRecovery = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
  let restartManagement: (() => void) | undefined
  try {
    await until(() => pending.has(f.project.id), f.project.id)
    const original = pending.get(f.project.id)!
    f.stop(); original.finish()
    await until(() => runs.getOwnerPlanningRunOutcome(original.executionId)?.state === 'failed', f.project.id)
    process.env.GRAVITAS_PACKAGE_SMOKE = '1'
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = original.executionId
    scenarios.set(f.project.id, { hold: true })
    const recoverySmoke = await import('./owner-quality-protocol-recovery-smoke')
    recoverySmoke.resumeFailedOwnerQualityForSmoke(f.project.id, original.executionId)
    restartManagement = management.startOwnerManagementLoop()
    await until(() => pending.get(f.project.id)?.executionId !== original.executionId, f.project.id)
    const executionId = pending.get(f.project.id)!.executionId
    const planningTaskId = store.getAgentExecution(executionId)!.entityId
    const frozen = source.readOwnerPlanningSnapshot(planningTaskId)!
    expect(frozen.context.conversation?.deliveryReview?.qualityRecovery?.previousExecutionId).toBe(original.executionId)
    const reviewerCommandId = frozen.context.conversation!.executionObservation!.commandId
    delegation.revokeOwnerManagementDelegation(f.project.id, delegation.getOwnerManagementDelegation(f.project.id).delegation!.id)
    expect(actions.getOwnerQualityRecovery(f.project.id, reviewerCommandId)).toBeNull()
    const conversation = await import('./project-owner-management-conversation')
    const replay = conversation.withOwnerConversationContext(plans.getProjectOwnerPlanningContext(f.project.id), frozen.link.conversationMessageId!, frozen.context.conversation?.historyThroughMessageId,
      frozen.context.conversation?.interactionVersion ?? 1, 1, 1, frozen.context.conversation?.employeeInteractionVersion ?? 0, frozen.context.conversation?.employeeInteractions, true, frozen.context.conversation?.deliveryReview)
    expect(replay).toEqual(frozen.context)
    expect(source.resolveOwnerPlanningTask(planningTaskId)!.context).toEqual(frozen.context)
    expect(() => delegation.assertOwnerManagementTask(executionId)).toThrow('委托已撤销')
  } finally {
    restartManagement?.(); f.stop()
    if (savedSmoke === undefined) delete process.env.GRAVITAS_PACKAGE_SMOKE
    else process.env.GRAVITAS_PACKAGE_SMOKE = savedSmoke
    if (savedRecovery === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = savedRecovery
  }
}, 15000)


test('Given研发首轮完整冻结源码与Owner返工决定 When启动返工 Then使用新会话继承源码并保留原会话证据', async () => {
  const f = await fixture({ development: true, rework: true, ownerDefect: true })
  try {
    await until(() => f.tasks().every(task => task.status === 'completed'), f.project.id)
    const records=await import('./project-owner-management-store')
    await until(()=>records.getOwnerManagementView(f.project.id).messages.some(item=>item.kind==='delivery'),f.project.id)
    const delivered=records.getOwnerManagementView(f.project.id).messages.find(item=>item.kind==='delivery')!.delivery!
    expect(delivered.items[0]!.artifactHash).toBe(actionRows(f.project.id).at(-1)!.artifactHash)
    const damaged=structuredClone(delivered), serialized=JSON.parse(damaged.items[0]!.content)
    serialized.files[0].newContent+='tampered'
    damaged.items[0]!.content=JSON.stringify(serialized)
    expect(()=>records.appendOwnerManagementMessage({projectId:f.project.id,eventId:randomUUID(),role:'assistant',kind:'delivery',content:'invalid',delivery:damaged})).toThrow('Owner成果条目无效')
    const executions=store.listAgentExecutionsByProject(f.project.id).filter(item=>item.ownerCommandId)
    const executors=executions.filter(item=>store.getProjectDb().prepare("SELECT 1 FROM project_owner_execution_commands WHERE id=? AND role='executor'").get(item.ownerCommandId!)).sort((left,right)=>left.startedAt-right.startedAt)
    expect(executors).toHaveLength(2)
    expect(new Set(executors.map(item=>item.sessionId)).size).toBe(2)
    expect(actionRows(f.project.id).map(item=>item.state)).toEqual(['rework_authorized','accepted'])
    const first=executors[0]!, workspace=workspaces.getAgentWorkspace(store.getTask(first.entityId)!.workspaceId!)!
    const content=readFileSync(join(workspaces.getAgentWorkspaceCwd(workspace,first.sessionId),'src/solution.cjs'),'utf8')
    expect(content).toContain('answer: 42')
    expect(executors[1]!.prompt).toContain(first.id)
  } finally { f.stop() }
},30000)
