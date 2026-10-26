import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from 'jotai'
import type { ProjectOwnerExecutionLaunchApi, ProjectOwnerGoalResult } from '@gravitas/shared'
import { buildElectronMock } from '../../main/lib/testing/electron-mock'
import { ownerManagementApiAtom, getOwnerManagementEditor, ownerManagementEditorsAtom } from './project-owner-management-atoms'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from './project-owner-plan-atoms'
import { getOwnerExecutionEditor, ownerExecutionApiAtom, ownerExecutionEditorsAtom, ownerExecutionInput } from './project-owner-execution-atoms'
import { getOwnerTaskEditor, ownerTaskApiAtom, ownerTaskEditorsAtom, ownerTaskRefreshAtom } from './project-owner-task-atoms'
import { ownerRevalidationApiAtom, getOwnerRevalidationEditor, ownerRevalidationEditorsAtom } from './project-owner-execution-revalidation-atoms'
import { ownerGrantApiAtom } from './project-owner-execution-grant-atoms'
import { confirmOwnerDeliveryTasksAtom, continueOwnerDeliveryRevalidationAtom, getOwnerDeliveryFlow, launchOwnerDeliveryAtom, loadOwnerDeliveryFlowAtom, ownerDeliveryFlowsAtom, ownerExecutionLaunchApiAtom, reviewOwnerManagedExecutionAtom } from './owner-delivery-flow-atoms'

const directory = mkdtempSync(join(tmpdir(), 'owner-delivery-flow-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('../../main/lib/agent-service', () => ({ isAgentSessionActive: () => false }))
const db = await import('../../main/lib/project-sqlite-store')
const employees = await import('../../main/lib/agent-employee-service')
const { createAgentWorkspace } = await import('../../main/lib/agent-workspace-manager')
const { createChannel } = await import('../../main/lib/channel-manager')
const { bindWorkspaceToProject } = await import('../../main/lib/project-workspace-bindings')
const goals = await import('../../main/lib/project-owner-goal-service')
const plans = await import('../../main/lib/project-owner-plan-service')
const prep = await import('../../main/lib/project-owner-execution-preparation')
const tasks = await import('../../main/lib/project-owner-task-materialization')
const validation = await import('../../main/lib/project-owner-execution-revalidation')
const grants = await import('../../main/lib/project-owner-execution-grant-issue')
const { launchOwnerPreparedExecution } = await import('../../main/lib/project-owner-execution-launch')
const startIntents = await import('../../main/lib/project-owner-execution-start-intent')
const ownerManagement = await import('../../main/lib/project-owner-management-store')
const delegation = await import('../../main/lib/project-owner-management-delegation')
const ownerBinding = await import('../../main/lib/project-owner-runtime-binding')
const { reconcileOwnerManagement } = await import('../../main/lib/project-owner-management-loop')
interface LaunchCounters { launches: number; schedules: number; grantId?: string }
beforeAll(async () => { await db.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); db.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
const subjectOf = (r: { projectId: string; taskId?: string }) => ({ projectId: r.projectId, ...(r.taskId ? { taskId: r.taskId } : {}) })
async function response<T>(run: () => T): Promise<ProjectOwnerGoalResult<T>> {
  try { return { ok: true, value: run() } }
  catch (cause) { return { ok: false, error: { code: 'conflict', message: cause instanceof Error ? cause.message : '失败' } } }
}
function fixture(options?: { grant?: boolean }) {
  const store = createStore(), project = db.createProject({ title: '连续交付', description: '' }), subject = { projectId: project.id }, key = JSON.stringify([project.id, null])
  const workspace = createAgentWorkspace(`delivery-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake-only', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: '测试', enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'glm-5.3-flash', workspaceIds: [workspace.id] })
  const owner = employee('Owner'), executor = employee('研究'), reviewer = employee('评审')
  ownerBinding.saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: owner.id, workspaceId: workspace.id, changeReason: '测试夹具' })
  reconcileOwnerManagement(project.id)
  const goal = goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成可审阅方案' })
  const context = plans.getProjectOwnerPlanningContext(project.id), roleKey = context.sources.roles[0]!.key
  const steps = [{ key: 'brief', title: '调研', outcome: '材料', acceptanceCriteria: ['来源明确'], dependencies: [], roleKey }, { key: 'report', title: '汇总', outcome: '方案', acceptanceCriteria: ['有取舍'], dependencies: ['brief'], roleKey }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '方案', assumptions: [], risks: [], steps, changeReason: '建立计划' })
  const plan = plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const input = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: plan.revision, selectedStepKeys: steps.map(step => step.key), executionKind: 'controlled' as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [{ roleKey, employeeId: executor.id }], workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1000000, maxRuns: 4, maxRework: 1, expiresAt: Date.now() + 3600000, changeReason: '按方案准备' }
  const preview = prep.previewOwnerExecutionPreparation(subject, input), preparation = prep.saveOwnerExecutionPreparation(subject, input, preview.previewFingerprint)
  store.set(ownerGoalEditorsAtom, new Map([[key, { ...getOwnerGoalEditor(new Map(), subject), loaded: true, snapshot: goal }]]))
  store.set(ownerPlanEditorsAtom, new Map([[key, { ...getOwnerPlanEditor(new Map(), subject), loaded: true, snapshot: plan, context }]]))
  store.set(ownerExecutionEditorsAtom, new Map([[key, { ...getOwnerExecutionEditor(new Map(), subject), loaded: true, view: prep.getOwnerExecutionPreparation(subject) }]]))
  const effects = { materializations: 0, revalidations: 0 }
  let grantIssues = 0
  let failValidation = false, loseReply = false
  store.set(ownerManagementApiAtom, { getOwnerManagement: s => response(() => ownerManagement.getOwnerManagementView(s.projectId)), answerOwnerManagementQuestion: async () => { throw Error('本用例不答复问题') } })
  store.set(ownerExecutionApiAtom, { getOwnerExecutionPreparation: s => response(() => prep.getOwnerExecutionPreparation(s)), listOwnerExecutionPreparationHistory: async () => ({ ok: true, value: [] }), previewOwnerExecutionPreparation: r => response(() => prep.previewOwnerExecutionPreparation(subjectOf(r), r.input)), saveOwnerExecutionPreparation: r => response(() => prep.saveOwnerExecutionPreparation(subjectOf(r), r.input, r.previewFingerprint)) })
  store.set(ownerTaskApiAtom, {
    getOwnerTaskMaterialization: s => response(() => tasks.getOwnerTaskMaterialization(s)), listOwnerTaskMaterializationHistory: s => response(() => tasks.listOwnerTaskMaterializationHistory(s)),
    previewOwnerTaskMaterialization: r => response(() => tasks.previewOwnerTaskMaterialization(subjectOf(r), r.input)),
    materializeOwnerTasks: async r => { effects.materializations++; const result = await response(() => tasks.materializeOwnerTasks(subjectOf(r), r.input, r.previewFingerprint)); if (loseReply) { loseReply = false; throw Error('登记回包丢失') } return result },
  })
  store.set(ownerTaskRefreshAtom, { listTasks: async () => undefined })
  store.set(ownerRevalidationApiAtom, {
    getOwnerExecutionRevalidation: s => response(() => validation.getOwnerExecutionRevalidation(s)), listOwnerExecutionRevalidationHistory: s => response(() => validation.listOwnerExecutionRevalidationHistory(s)),
    previewOwnerExecutionRevalidation: r => { if (failValidation) { failValidation = false; return response(() => { throw Error('模拟核验失败') }) } return response(() => validation.previewOwnerExecutionRevalidation(subjectOf(r), r.input)) },
    saveOwnerExecutionRevalidation: r => { effects.revalidations++; return response(() => validation.saveOwnerExecutionRevalidation(subjectOf(r), r.input, r.previewFingerprint)) },
  })
  store.set(ownerGrantApiAtom, {
    getOwnerExecutionGrant: s => response(() => grants.getOwnerExecutionGrant(s)), listOwnerExecutionGrantHistory: async () => ({ ok: true, value: [] }),
    previewOwnerExecutionGrantIssue: r => options?.grant ? response(() => grants.previewOwnerExecutionGrantIssue(subjectOf(r), r.input)) : (async () => { throw Error('不应自动请求授权') })(),
    confirmOwnerExecutionGrantIssue: r => options?.grant ? (() => { grantIssues++; return response(() => grants.confirmOwnerExecutionGrantIssue(subjectOf(r), { input: r.input, preview: r.preview, confirmedFingerprint: r.confirmedFingerprint })) })() : (async () => { throw Error('不应自动发行授权') })(),
    previewOwnerExecutionGrantRevoke: async () => { throw Error('不应撤权') }, confirmOwnerExecutionGrantRevoke: async () => { throw Error('不应撤权') },
  })
  return { store, subject, preparation, effects, grantIssues: () => grantIssues, failValidation: () => { failValidation = true }, loseReply: () => { loseReply = true } }
}

function authorizeProjectBudget(f: ReturnType<typeof fixture>) {
  const input = { projectId: f.subject.projectId, requestId: randomUUID(), maxRequests: 6, maxCostMicros: 4_000_000, expiresAt: Date.now() + 6 * 3_600_000 }
  const preview = delegation.previewOwnerManagementDelegation(input)
  return delegation.confirmOwnerManagementDelegation({ input, previewHash: preview.previewHash })
}

function startIntentApi(subject: { projectId: string; taskId?: string }, counters: LaunchCounters, afterResume?: () => void, intentIds?: { saved: string[]; resumed: string[] }): Pick<ProjectOwnerExecutionLaunchApi, 'saveOwnerExecutionStartIntent' | 'resumeOwnerExecutionStartIntent'> {
  return {
    saveOwnerExecutionStartIntent: request => { intentIds?.saved.push(request.intentId); return response(() => startIntents.saveOwnerExecutionStartIntent(request)) },
    resumeOwnerExecutionStartIntent: async request => {
      intentIds?.resumed.push(request.intentId)
      let value
      try {
        value = await startIntents.resumeOwnerExecutionStartIntent(request.intentId, subjectOf(request), {
          launch: async launchRequest => {
            counters.launches++
            const grant = await launchOwnerPreparedExecution(launchRequest, { schedule: async () => { counters.schedules++ } })
            counters.grantId = grant.grantId
            return grant
          },
        })
      } catch (cause) {
        return { ok: false, error: { code: 'failed', message: cause instanceof Error ? cause.message : '启动失败' } }
      }
      afterResume?.()
      return { ok: true, value }
    },
  }
}
const flow = (f: ReturnType<typeof fixture>) => getOwnerDeliveryFlow(f.store.get(ownerDeliveryFlowsAtom), f.subject)
const taskEditor = (f: ReturnType<typeof fixture>) => getOwnerTaskEditor(f.store.get(ownerTaskEditorsAtom), f.subject)
function editOwnerExecution(f: ReturnType<typeof fixture>) {
  const input = f.preparation.input
  const editor = getOwnerExecutionEditor(f.store.get(ownerExecutionEditorsAtom), f.subject)
  const date = new Date(input.expiresAt), pad = (value: number) => String(value).padStart(2, '0')
  f.store.set(ownerExecutionEditorsAtom, new Map([[JSON.stringify([f.subject.projectId, null]), {
    ...editor, dirty: true, requestId: randomUUID(), selectedStepKeys: [...input.selectedStepKeys], executionKind: input.executionKind,
    executorEmployeeId: input.executorEmployeeId, reviewerEmployeeId: input.reviewerEmployeeId,
    roleAssignments: Object.fromEntries((input.roleAssignments ?? []).map(item => [item.roleKey, item.employeeId])), workspaceId: input.workspaceId,
    knowledgeSourceIds: [...input.knowledgeSourceIds], maxCostMicrosText: String(input.maxCostMicros), maxRunsText: String(input.maxRuns),
    maxReworkText: String(input.maxRework), expiresAtText: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`,
    changeReason: '用户确认结果范围',
  }]]))
}

test('GivenOwner已安排并展示结果边界 When用户一次确认 Then准备、任务登记、核验、授权和调度自动连续完成', async () => {
  const f = fixture()
  authorizeProjectBudget(f)
  editOwnerExecution(f)
  expect(ownerExecutionInput(atom => f.store.get(atom), f.subject)).not.toBeNull()
  const counters: LaunchCounters = { launches: 0, schedules: 0 }
  const intentIds = { saved: [] as string[], resumed: [] as string[] }
  f.store.set(ownerExecutionLaunchApiAtom, startIntentApi(f.subject, counters, undefined, intentIds))

  await f.store.set(reviewOwnerManagedExecutionAtom, f.subject)

  expect(getOwnerExecutionEditor(f.store.get(ownerExecutionEditorsAtom), f.subject).error).toBe('')
  expect(getOwnerExecutionEditor(f.store.get(ownerExecutionEditorsAtom), f.subject).view?.status).toBe('stale')
  expect(getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), f.subject).snapshot?.state).toBe('confirmed')
  expect(counters.launches).toBe(1)
  expect(counters.schedules).toBe(1)
  expect(counters.grantId).toBeTruthy()
  expect(intentIds.saved).toHaveLength(1)
  expect(intentIds.resumed).toEqual(intentIds.saved)
  expect(flow(f).error).toBe('')
  expect(getOwnerManagementEditor(f.store.get(ownerManagementEditorsAtom), f.subject.projectId).view?.messages.some(message => message.kind === 'management_progress' && message.content.includes('已按你确认的结果与边界开始组织执行'))).toBe(true)
  expect(grants.getOwnerExecutionGrant(f.subject)?.state).toBe('active')
  expect(db.listTasks(f.subject.projectId)).toHaveLength(2)
  expect(f.effects).toEqual({ materializations: 0, revalidations: 0 })
})

test('Given授权已提交但Renderer回包丢失 When用户重试 Then重提同一冻结请求并幂等恢复调度', async () => {
  const f = fixture()
  authorizeProjectBudget(f)
  editOwnerExecution(f)
  const counters: LaunchCounters = { launches: 0, schedules: 0 }
  let resumes = 0
  const intentIds = { saved: [] as string[], resumed: [] as string[] }
  f.store.set(ownerExecutionLaunchApiAtom, startIntentApi(f.subject, counters, () => { if (++resumes === 1) throw Error('Renderer IPC回包丢失') }, intentIds))

  await f.store.set(reviewOwnerManagedExecutionAtom, f.subject)
  const committedPreparation = prep.getOwnerExecutionPreparation(f.subject).preparation
  expect(flow(f).error).toContain('Renderer IPC回包丢失')
  expect(flow(f).pendingStartIntentId).toBeTruthy()
  expect(grants.getOwnerExecutionGrant(f.subject)?.grantId).toBe(counters.grantId)

  await f.store.set(reviewOwnerManagedExecutionAtom, f.subject)

  expect(counters.launches).toBe(1)
  expect(counters.schedules).toBe(1)
  expect(intentIds.saved).toHaveLength(1)
  expect(intentIds.resumed).toHaveLength(2)
  expect(new Set(intentIds.resumed)).toEqual(new Set(intentIds.saved))
  expect(grants.getOwnerExecutionGrant(f.subject)?.grantId).toBe(counters.grantId)
  expect(prep.getOwnerExecutionPreparation(f.subject).preparation?.integrityHash).toBe(committedPreparation?.integrityHash)
  expect(tasks.listOwnerTaskMaterializationHistory(f.subject)).toHaveLength(1)
  expect(flow(f).pendingStartIntentId).toBeNull()
})

test('Given应用重开且启动授权已提交 When读取权威批次后继续 Then恢复同一授权与批次并唤醒调度', async () => {
  const f = fixture()
  authorizeProjectBudget(f)
  editOwnerExecution(f)
  const counters: LaunchCounters = { launches: 0, schedules: 0 }
  let resumes = 0
  f.store.set(ownerExecutionLaunchApiAtom, startIntentApi(f.subject, counters, () => { if (++resumes === 1) throw Error('Renderer IPC回包丢失') }))
  await f.store.set(reviewOwnerManagedExecutionAtom, f.subject)
  const grantId = grants.getOwnerExecutionGrant(f.subject)?.grantId
  expect(flow(f).pendingStartIntentId).toBeTruthy()

  // 模拟进程重开：Jotai内存状态丢失，持久服务仍保有已提交批次和授权。
  f.store.set(ownerDeliveryFlowsAtom, new Map())
  await f.store.set(reviewOwnerManagedExecutionAtom, f.subject)

  expect(counters.launches).toBe(1)
  expect(counters.schedules).toBe(1)
  expect(grants.getOwnerExecutionGrant(f.subject)?.grantId).toBe(grantId)
  expect(counters.grantId).toBe(grantId)
  expect(tasks.listOwnerTaskMaterializationHistory(f.subject)).toHaveLength(1)
  expect(flow(f).pendingStartIntentId).toBeNull()
  expect(flow(f).error).toBe('')
})

test('Given已确认的启动意图恢复前目标来源变化 When后台Owner核对 Then不派发并在同一对话说明需重新确认', async () => {
  const f = fixture()
  editOwnerExecution(f)
  const plan = getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), f.subject).snapshot!
  const input = ownerExecutionInput(atom => f.store.get(atom), f.subject)!
  startIntents.saveOwnerExecutionStartIntent({ ...f.subject, intentId: input.requestId, expectedGoalRevision: input.expectedGoalRevision,
    expectedPlanRevision: input.expectedPlanRevision, planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input })
  goals.saveProjectOwnerGoalDraft(f.subject.projectId, 1, { objective: '变更后的目标' })

  await startIntents.recoverPendingOwnerExecutionStartIntents(f.subject.projectId)

  const messages = ownerManagement.getOwnerManagementView(f.subject.projectId).messages
  expect(messages.at(-1)).toMatchObject({ role: 'assistant', kind: 'attention', conversationId: ownerManagement.getOwnerManager(f.subject.projectId)?.conversationId })
  expect(messages.at(-1)?.content).toContain('目标、方案或执行边界已变化')
  expect(startIntents.listPendingOwnerExecutionStartIntents().map(intent => intent.intentId)).not.toContain(input.requestId)
  expect(grants.getOwnerExecutionGrant(f.subject)).toBeNull()
  expect(db.listTasks(f.subject.projectId)).toHaveLength(0)
})

test('Given待恢复列表中有损坏意图 WhenOwner逐条核对 Then隔离损坏项并继续恢复有效确认', async () => {
  const f = fixture()
  authorizeProjectBudget(f)
  const plan = getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), f.subject).snapshot!
  const input = f.preparation.input
  const intentRequest = (intentId: string) => ({ ...f.subject, intentId, expectedGoalRevision: input.expectedGoalRevision,
    expectedPlanRevision: input.expectedPlanRevision, planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input })
  const brokenId = randomUUID(), validId = randomUUID()
  startIntents.saveOwnerExecutionStartIntent(intentRequest(brokenId))
  db.getProjectDb().prepare("UPDATE project_owner_execution_start_intents SET payload='{' ,created_at=1 WHERE id=?").run(brokenId)
  startIntents.saveOwnerExecutionStartIntent(intentRequest(validId))
  let schedules = 0

  await startIntents.recoverPendingOwnerExecutionStartIntents(f.subject.projectId, {
    launch: request => launchOwnerPreparedExecution(request, { schedule: async () => { schedules++ } }),
  })

  const rows = db.getProjectDb().prepare('SELECT id,state,recovery_status FROM project_owner_execution_start_intents WHERE id IN (?,?) ORDER BY id').all(brokenId, validId)
  expect(rows).toEqual([
    { id: brokenId, state: 'pending', recovery_status: 'needs_attention' },
    { id: validId, state: 'completed', recovery_status: 'pending' },
  ].sort((left, right) => left.id.localeCompare(right.id)))
  expect(schedules).toBe(1)
  expect(grants.getOwnerExecutionGrant(f.subject)?.state).toBe('active')
  expect(ownerManagement.getOwnerManagementView(f.subject.projectId).messages.some(message => message.eventId === `execution-start-recovery:${brokenId}:attention`)).toBe(true)
})

test('Given来源变化提醒暂时无法落盘 WhenOwner再次核对 Then重试提醒后隔离意图且不派发', async () => {
  const f = fixture()
  const plan = getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), f.subject).snapshot!
  const input = f.preparation.input, intentId = randomUUID(), eventId = `execution-start-recovery:${intentId}:attention`
  startIntents.saveOwnerExecutionStartIntent({ ...f.subject, intentId, expectedGoalRevision: input.expectedGoalRevision,
    expectedPlanRevision: input.expectedPlanRevision, planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input })
  goals.saveProjectOwnerGoalDraft(f.subject.projectId, 1, { objective: '变化后的目标' })
  db.getProjectDb().exec(`CREATE TRIGGER fail_owner_start_attention BEFORE INSERT ON project_owner_management_messages
    WHEN NEW.event_id='${eventId}' BEGIN SELECT RAISE(ABORT, '模拟提醒写入失败'); END`)
  let launches = 0
  const dependencies = { launch: async () => { launches++; throw Error('来源变化时不应启动') } }

  try {
    await startIntents.recoverPendingOwnerExecutionStartIntents(f.subject.projectId, dependencies)
    expect((db.getProjectDb().prepare('SELECT recovery_status FROM project_owner_execution_start_intents WHERE id=?').get(intentId) as { recovery_status: string }).recovery_status).toBe('pending')
    expect(launches).toBe(0)
  } finally { db.getProjectDb().exec('DROP TRIGGER IF EXISTS fail_owner_start_attention') }

  await startIntents.recoverPendingOwnerExecutionStartIntents(f.subject.projectId, dependencies)

  expect((db.getProjectDb().prepare('SELECT recovery_status FROM project_owner_execution_start_intents WHERE id=?').get(intentId) as { recovery_status: string }).recovery_status).toBe('needs_attention')
  expect(ownerManagement.getOwnerManagementView(f.subject.projectId).messages.some(message => message.eventId === eventId)).toBe(true)
  expect(launches).toBe(0)
})

test('Given原授权待核对且恢复途中项目被暂停 When后台恢复启动意图 Then提醒一次并停止重复派发', async () => {
  const f = fixture()
  authorizeProjectBudget(f)
  const plan = getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), f.subject).snapshot!
  const input = f.preparation.input, intentId = randomUUID()
  const materializationInput = {
    requestId: `owner-start:${intentId}`,
    expectedMaterializationRevision: tasks.getOwnerTaskMaterialization(f.subject).revision,
    expectedPreparationId: f.preparation.id,
    expectedPreparationRevision: f.preparation.revision,
    expectedPreparationHash: f.preparation.integrityHash,
    expectedPolicyRevision: f.preparation.policyRevision,
  }
  const materializationPreview = tasks.previewOwnerTaskMaterialization(f.subject, materializationInput)
  const materialization = await tasks.materializeOwnerTasks(f.subject, materializationInput, materializationPreview.previewFingerprint)
  let schedules = 0, recoveryLaunches = 0
  await launchOwnerPreparedExecution({ ...f.subject, input: materialization.input, previewFingerprint: materialization.preview.previewFingerprint }, {
    schedule: async () => { schedules++ },
  })
  db.getProjectDb().prepare("UPDATE project_owner_execution_grants SET state='needs_reconcile' WHERE project_id=?").run(f.subject.projectId)
  startIntents.saveOwnerExecutionStartIntent({ ...f.subject, intentId, expectedGoalRevision: input.expectedGoalRevision,
    expectedPlanRevision: input.expectedPlanRevision, planFingerprint: plan.planFingerprint, contextFingerprint: plan.contextFingerprint, input })
  const dependencies = {
    launch: async (request: unknown) => {
      recoveryLaunches++
      const manager = ownerManagement.getOwnerManager(f.subject.projectId)!
      ownerManagement.setOwnerManagerStatus(f.subject.projectId, manager.revision, 'paused')
      return launchOwnerPreparedExecution(request, { schedule: async () => { schedules++ } })
    },
  }

  await startIntents.recoverPendingOwnerExecutionStartIntents(f.subject.projectId, dependencies)
  const firstStatus = (db.getProjectDb().prepare('SELECT recovery_status FROM project_owner_execution_start_intents WHERE id=?').get(intentId) as { recovery_status: string }).recovery_status
  const attentionEventId = `execution-start-recovery:${intentId}:attention`
  expect(firstStatus).toBe('needs_attention')
  expect(recoveryLaunches).toBe(1)
  expect(schedules).toBe(1)
  const attention = ownerManagement.getOwnerManagementView(f.subject.projectId).messages.find(message => message.eventId === attentionEventId)
  expect(attention?.content).toContain('已有执行授权或授权状态需要核对')
  expect(attention?.content).toContain('不会自动重试')
  expect(attention?.content).toContain('请先核对原授权')
  expect(attention?.content).not.toContain('我会继续核对')

  await startIntents.recoverPendingOwnerExecutionStartIntents(f.subject.projectId, dependencies)

  expect(recoveryLaunches).toBe(1)
  expect(schedules).toBe(1)
  expect(ownerManagement.getOwnerManagementView(f.subject.projectId).messages.filter(message => message.eventId === attentionEventId)).toHaveLength(1)
})

test('Given真实SQLite暂停准备 When只读恢复、确认登记 Then 自动核验且预算期限不变、零授权和命令', async () => {
  const f = fixture()
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  expect(f.effects).toEqual({ materializations: 0, revalidations: 0 })
  expect(taskEditor(f).preview?.projections).toHaveLength(2)
  await Promise.all([f.store.set(confirmOwnerDeliveryTasksAtom, f.subject), f.store.set(confirmOwnerDeliveryTasksAtom, f.subject)])
  expect(flow(f).error).toBe('')
  expect(f.effects).toEqual({ materializations: 1, revalidations: 1 })
  const result = getOwnerRevalidationEditor(f.store.get(ownerRevalidationEditorsAtom), f.subject)
  expect(result.view?.status).toBe('current')
  expect(result.view?.revalidation?.source.budget.expiresAt).toBe(f.preparation.input.expiresAt)
  expect(result.view?.revalidation?.source.budget.maxCostMicros).toBe(1000000)
  expect(grants.getOwnerExecutionGrant(f.subject)).toBeNull()
  expect(db.listTasks(f.subject.projectId)).toHaveLength(2)
  expect((db.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands').get() as { count: number }).count).toBe(0)
})
test('Given登记成功但核验失败 When显式续接 Then只核验、不再创建任务', async () => {
  const f = fixture(); f.failValidation()
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  await f.store.set(confirmOwnerDeliveryTasksAtom, f.subject)
  expect(flow(f).error).toContain('模拟核验失败')
  expect(db.listTasks(f.subject.projectId)).toHaveLength(2)
  await f.store.set(continueOwnerDeliveryRevalidationAtom, f.subject)
  expect(flow(f).error).toBe('')
  expect(f.effects).toEqual({ materializations: 1, revalidations: 1 })
})
test('Given登记已落盘但回包丢失 When重新读取并继续 Then恢复相同批次、零重复Task', async () => {
  const f = fixture(); f.loseReply()
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  await f.store.set(confirmOwnerDeliveryTasksAtom, f.subject)
  expect(flow(f).error).toContain('登记回包丢失')
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  expect(taskEditor(f).view?.materialization?.links).toHaveLength(2)
  await f.store.set(continueOwnerDeliveryRevalidationAtom, f.subject)
  expect(flow(f).error).toBe('')
  expect(f.effects).toEqual({ materializations: 1, revalidations: 1 })
  expect(db.listTasks(f.subject.projectId)).toHaveLength(2)
})

// 浏览器通过loopback桥调用真实业务服务；交付命令回报单独标注为合成，不启动Runtime。
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import type { OwnerExecutionCommandView } from '@gravitas/shared'
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
for (const managed of [false, true]) {
browserTest(`Given真实任务服务与${managed ? 'Owner自主' : '旧手动'}模式 When最终确认与合成交付反馈 Then同页推进且反馈不扩权`, async () => {
  const f = fixture(), renderer = resolve(import.meta.dir, '..'), root = resolve(import.meta.dir, '../../../../..')
  if (managed) authorizeProjectBudget(f)
  const goal = getOwnerGoalEditor(f.store.get(ownerGoalEditorsAtom), f.subject).snapshot
  const plan = getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), f.subject)
  const execution = getOwnerExecutionEditor(f.store.get(ownerExecutionEditorsAtom), f.subject)
  const seed = { subject: f.subject, goal, plan: plan.snapshot, context: plan.context, preparation: execution.view }
  let delivered: OwnerExecutionCommandView[] = [], commandReads = 0
  const artifactContent = '已验收交付的完整正文', artifactHash = 'a'.repeat(64), deliveryMessageId = 'c'.repeat(64)
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/entry.js') return new Response(Bun.file(join(directory, 'browser.js')))
    if (path !== '/api') return new Response('<html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } })
    const raw: unknown = await request.json()
    if (!raw || typeof raw !== 'object') return Response.json({ ok: false })
    const { method, payload } = raw as { method: string; payload: Record<string, unknown> }
    const subject = { projectId: payload.projectId, ...(payload.taskId ? { taskId: payload.taskId } : {}) }
    if (method === 'launchOwnerPreparedExecution') {
      try {
        const value = await launchOwnerPreparedExecution(payload, { schedule: async () => {} })
        return Response.json({ ok: true, value })
      } catch (cause) { return Response.json({ ok: false, error: { code: 'failed', message: String(cause) } }) }
    }
    const result = await response(() => {
      switch (method) {
        case 'getOwnerTaskMaterialization': return tasks.getOwnerTaskMaterialization(subject)
        case 'previewOwnerTaskMaterialization': return tasks.previewOwnerTaskMaterialization(subject, payload.input)
        case 'materializeOwnerTasks': return tasks.materializeOwnerTasks(subject, payload.input, payload.previewFingerprint)
        case 'getOwnerExecutionPreparation': return prep.getOwnerExecutionPreparation(subject)
        case 'getOwnerExecutionRevalidation': return validation.getOwnerExecutionRevalidation(subject)
        case 'previewOwnerExecutionRevalidation': return validation.previewOwnerExecutionRevalidation(subject, payload.input)
        case 'saveOwnerExecutionRevalidation': return validation.saveOwnerExecutionRevalidation(subject, payload.input, payload.previewFingerprint)
        case 'getOwnerExecutionGrant': return grants.getOwnerExecutionGrant(subject)
        case 'previewOwnerExecutionGrantIssue': return grants.previewOwnerExecutionGrantIssue(subject, payload.input)
        case 'confirmOwnerExecutionGrantIssue': return grants.confirmOwnerExecutionGrantIssue(subject, { input: payload.input, preview: payload.preview, confirmedFingerprint: payload.confirmedFingerprint })
        case 'previewOwnerExecutionGrantRevoke': return grants.previewOwnerExecutionGrantRevoke(subject, { grantId: payload.grantId })
        case 'confirmOwnerExecutionGrantRevoke': return grants.confirmOwnerExecutionGrantRevoke(subject, { grantId: payload.grantId, confirmedFingerprint: payload.confirmedFingerprint })
        case 'listOwnerExecutionGrantHistory': return grants.listOwnerExecutionGrantHistory(subject)
        case 'getOwnerGoalDraft': return goals.getProjectOwnerGoalDraft(f.subject.projectId, typeof payload.taskId === 'string' ? payload.taskId : undefined)
        case 'listOwnerExecutionCommands': commandReads++; return delivered
        case 'getOwnerAutonomousScheduleStatus': return { projectId: f.subject.projectId, state: 'manual', reservedCostMicros: 0, committedCostMicros: 0, runReservations: 0, reason: delivered.length ? '合成交付已就绪' : '等待人工执行确认', ...(delivered.length ? { taskId: delivered[0]!.taskId, nextAction: 'await_business_acceptance' } : {}) }
        case 'testDeliver': {
          const grant = grants.getOwnerExecutionGrant(f.subject)!, task = db.listTasks(f.subject.projectId)[0]!
          delivered = [{ commandId: 'synthetic-delivery', grantId: grant.grantId, taskId: task.id, taskTitle: task.title, stepKey: 'brief', employeeId: grant.executorEmployeeId, role: 'executor', reworkOrdinal: 0, state: 'settled', executionId: 'synthetic-run', executionStatus: 'completed', executionResultSummary: '合成回报：定位报告待人工审阅', textDelivery: { state: 'available', detail: '合成成果', artifact: { schemaVersion: 1, projectId: f.subject.projectId, grantId: grant.grantId, commandId: 'synthetic-delivery', executionId: 'synthetic-run', sessionId: 'synthetic-session', taskId: task.id, stepLinkId: 'synthetic-link', sourceHash: 'b'.repeat(64), planRevision: plan.snapshot!.revision, reworkOrdinal: 0, messageId: 'synthetic-message', content: artifactContent, contentSha256: artifactHash, byteLength: Buffer.byteLength(artifactContent), capturedAt: 1, integrityHash: 'd'.repeat(64) } }, acceptanceCriteria: ['来源明确'], reservedCostMicros: 100, actualCostMicros: null, grantAuthorization: { grantState: 'active', dispatchMode: 'manual', ...grant.budget, roleBudgetCaps: [] }, ackFingerprint: 'synthetic', createdAt: 1, updatedAt: 2 }]
          return null
        }
        default: if (method.startsWith('listOwner') && method.endsWith('History')) return []
          throw Error(`禁止此测试调用：${method}`)
      }
    })
    return Response.json(result)
  } })
  const entry = join(directory, 'browser.tsx')
  writeFileSync(entry, `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {ProjectOwnerDeliveryConversation} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerDeliveryConversation.tsx'))};
import {ownerGoalEditorsAtom,getOwnerGoalEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
import {ownerPlanEditorsAtom,getOwnerPlanEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-plan-atoms.ts'))};
import {ownerExecutionEditorsAtom,getOwnerExecutionEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-execution-atoms.ts'))};
import {ownerMessageComposersAtom,getOwnerMessageComposer} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
import {ownerManagementEditorsAtom,getOwnerManagementEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
const seed=${JSON.stringify(seed)},subject=seed.subject,key=JSON.stringify([subject.projectId,null]);
const call=async(method,payload=subject)=>(await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,payload})})).json();
const names=['launchOwnerPreparedExecution','getOwnerTaskMaterialization','listOwnerTaskMaterializationHistory','previewOwnerTaskMaterialization','materializeOwnerTasks','getOwnerExecutionPreparation','listOwnerExecutionPreparationHistory','previewOwnerExecutionPreparation','saveOwnerExecutionPreparation','getOwnerExecutionRevalidation','listOwnerExecutionRevalidationHistory','previewOwnerExecutionRevalidation','saveOwnerExecutionRevalidation','getOwnerExecutionGrant','listOwnerExecutionGrantHistory','previewOwnerExecutionGrantIssue','confirmOwnerExecutionGrantIssue','previewOwnerExecutionGrantRevoke','confirmOwnerExecutionGrantRevoke','listOwnerExecutionCommands','getOwnerAutonomousScheduleStatus','previewOwnerExecutionCommandAck','queueOwnerExecutionCommand','dispatchOwnerExecutionCommand','cancelQueuedOwnerExecutionCommand','previewOwnerPreflightReconciliation','confirmOwnerPreflightReconciliation','getOwnerGoalDraft','saveOwnerGoalDraft'];
window.electronAPI={listChannels:async()=>[],listAgentWorkspaces:async()=>[],paa:{project:{...Object.fromEntries(names.map(name=>[name,payload=>call(name,payload)])),listTasks:async()=>[],getOwnerRuntimeBinding:async()=>({ok:true,value:null})},agentEmployees:{list:async()=>[]},projectWorkspace:{listByProject:async()=>[]}}};
const store=createStore();store.set(ownerGoalEditorsAtom,new Map([[key,{...getOwnerGoalEditor(new Map(),subject),loaded:true,snapshot:seed.goal}]]));store.set(ownerPlanEditorsAtom,new Map([[key,{...getOwnerPlanEditor(new Map(),subject),loaded:true,snapshot:seed.plan,context:seed.context}]]));store.set(ownerExecutionEditorsAtom,new Map([[key,{...getOwnerExecutionEditor(new Map(),subject),loaded:true,view:seed.preparation}]]));
window.fixture={deliver:async()=>{await call('testDeliver');const result=await call('listOwnerExecutionCommands');const taskId=result.value[0].taskId;const delivery={schemaVersion:1,planVersion:1,items:[{stepKey:'brief',title:'Owner交付',acceptanceCriteria:['来源明确'],artifactHash:${JSON.stringify(artifactHash)},content:${JSON.stringify(artifactContent)},ownerDecision:'按标准接受',reviewerSummary:'独立评审通过'},{stepKey:'other',title:'另一项交付',acceptanceCriteria:['独立核验'],artifactHash:'e'.repeat(64),content:'其他成果正文',ownerDecision:'按标准接受',reviewerSummary:'独立评审通过'}]};const message={id:${JSON.stringify(deliveryMessageId)},projectId:subject.projectId,conversationId:'owner-conversation',eventId:'delivery',role:'assistant',kind:'delivery',content:'Owner已验收',delivery,createdAt:1};const taskMessage={...message,id:'d'.repeat(64),taskId,eventId:'task-delivery'};const owner=getOwnerManagementEditor(new Map(),subject.projectId);store.set(ownerManagementEditorsAtom,new Map([[subject.projectId,{...owner,view:{manager:{schemaVersion:1,projectId:subject.projectId,ownerId:'owner',conversationId:'owner-conversation',revision:1,status:'active',createdAt:1,updatedAt:1},messages:[message,taskMessage],questions:[],pendingEvents:0}}]]));},draft:taskId=>getOwnerGoalEditor(store.get(ownerGoalEditorsAtom),{...subject,taskId}),setMessage:text=>{const composer=getOwnerMessageComposer(store.get(ownerMessageComposersAtom),subject);store.set(ownerMessageComposersAtom,new Map([[key,{...composer,text}]]))}};
store.sub(ownerMessageComposersAtom,()=>{const composer=getOwnerMessageComposer(store.get(ownerMessageComposersAtom),subject);document.body.dataset.ownerComposer=composer.text;document.body.dataset.ownerDeliveryReference=JSON.stringify(composer.deliveryReference||null)});
createRoot(document.getElementById('root')).render(<Provider store={store}><ProjectOwnerDeliveryConversation projectId={subject.projectId} managed={${managed}} singleConfirmation={${managed}} ownerConversation={true}/></Provider>);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 390, height: 800 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.clock.install()
    await page.goto(`http://127.0.0.1:${server.port}`)
    if (managed) {
      expect(await page.getByRole('button', { name: '确认方案并开始执行', exact: true }).count()).toBe(0)
      await page.getByText('完成标准：来源明确', { exact: true }).waitFor()
      expect(await page.getByText('完成标准：来源明确', { exact: true }).count()).toBe(1)
      expect(grants.getOwnerExecutionGrant(f.subject)).toBeNull()
      expect(db.listTasks(f.subject.projectId)).toHaveLength(0)
      expect(errors).toEqual([])
      return
    }
    const start = page.getByRole('button', { name: '确认安排，登记、核验并签发执行授权', exact: true })
    await start.waitFor()
    expect(grants.getOwnerExecutionGrant(f.subject)).toBeNull()
    expect(db.listTasks(f.subject.projectId)).toHaveLength(0)
    await start.click()
    await page.getByText('Owner 已开始按确认范围推进', { exact: false }).waitFor()
    expect(grants.getOwnerExecutionGrant(f.subject)?.dispatchMode).toBe(managed ? 'autonomous' : 'manual')
    expect((db.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands').get() as { count: number }).count).toBe(0)
    await page.evaluate('window.fixture.deliver()')
    await page.clock.fastForward(4100)
    await page.getByText('成果已准备好，等待你审阅。', { exact: true }).waitFor()
    await page.getByText('交付审阅材料（只读）', { exact: true }).click()
    await page.evaluate('window.fixture.setMessage("  我还有一个未发出的问题  ")')
    await page.getByRole('button', { name: '在对话中继续修改', exact: true }).click()
    await page.getByText('已将这份成果的背景放入下方 Owner 对话。补充或修改内容后发送，Owner 会据此判断并继续处理。', { exact: true }).waitFor()
    const composer = await page.locator('body').getAttribute('data-owner-composer')
    expect(composer).toContain('  我还有一个未发出的问题  ')
    expect(composer).toContain(`我想继续修改《${delivered[0]!.taskTitle}》这份交付`)
    expect(composer).toContain('结合当前方案中的对应完成标准')
    expect(await page.locator('body').getAttribute('data-owner-delivery-reference')).toBe(JSON.stringify({ messageId: deliveryMessageId, artifactHash, stepKey: 'brief' }))
    await page.evaluate('window.fixture.setMessage("x".repeat(4000))')
    await page.getByRole('button', { name: '在对话中继续修改', exact: true }).click()
    await page.getByText('对话草稿已接近字数上限，无法安全加入成果背景；请先精简草稿再试。', { exact: true }).waitFor()
    expect(await page.locator('body').getAttribute('data-owner-composer')).toHaveLength(4000)
    expect(goals.getProjectOwnerGoalDraft(f.subject.projectId, delivered[0]!.taskId)).toBeNull()
    expect(grants.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(1)
    expect(commandReads).toBeGreaterThan(1)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
}

test('Given首次加载瞬态遗留需要比较 When当前来源已稳定 Then仅重建新摘要、不自动登记', async () => {
  const f = fixture(), key = JSON.stringify([f.subject.projectId, null])
  f.store.set(ownerTaskEditorsAtom, new Map([[key, { ...getOwnerTaskEditor(new Map(), f.subject), requiresReview: true }]]))
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  expect(taskEditor(f).preview?.projections).toHaveLength(2)
  expect(taskEditor(f).requiresReview).toBe(false)
  expect(f.effects).toEqual({ materializations: 0, revalidations: 0 })
})

test('Given已确认计划与当前暂停准备 When一键启动 Then顺序完成登记核验并发行授权、零命令零重复', async () => {
  const f = fixture({ grant: true })
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  await Promise.all([
    f.store.set(launchOwnerDeliveryAtom, { subject: f.subject, dispatchMode: 'manual' }),
    f.store.set(launchOwnerDeliveryAtom, { subject: f.subject, dispatchMode: 'manual' }),
  ])
  expect(flow(f).error).toBe('')
  expect(f.effects).toEqual({ materializations: 1, revalidations: 1 })
  expect(f.grantIssues()).toBe(1)
  const grant = grants.getOwnerExecutionGrant(f.subject)
  expect(grant?.state).toBe('active')
  expect(grant?.dispatchMode).toBe('manual')
  expect(db.listTasks(f.subject.projectId)).toHaveLength(2)
  expect((db.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands').get() as { count: number }).count).toBe(0)
  // 活动授权存在时再次一键启动必须可读拒绝，且不重复登记、核验或发行。
  await f.store.set(launchOwnerDeliveryAtom, { subject: f.subject, dispatchMode: 'manual' })
  expect(flow(f).error).toContain('已有活动或待对账授权')
  expect(f.effects).toEqual({ materializations: 1, revalidations: 1 })
  expect(f.grantIssues()).toBe(1)
})

test('Given一键启动在核验处失败 When再次一键启动 Then只续接核验并发行授权、不重复登记', async () => {
  const f = fixture({ grant: true })
  f.failValidation()
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  await f.store.set(launchOwnerDeliveryAtom, { subject: f.subject, dispatchMode: 'manual' })
  expect(flow(f).error).toContain('模拟核验失败')
  expect(f.effects).toEqual({ materializations: 1, revalidations: 0 })
  expect(f.grantIssues()).toBe(0)
  expect(db.listTasks(f.subject.projectId)).toHaveLength(2)
  await f.store.set(launchOwnerDeliveryAtom, { subject: f.subject, dispatchMode: 'manual' })
  expect(flow(f).error).toBe('')
  expect(f.effects).toEqual({ materializations: 1, revalidations: 1 })
  expect(f.grantIssues()).toBe(1)
  expect(grants.getOwnerExecutionGrant(f.subject)?.state).toBe('active')
  expect(db.listTasks(f.subject.projectId)).toHaveLength(2)
})


test('Given旧Owner托管卡片尝试启动 When重复点击 Then拒绝第二入口且不产生授权或任务', async () => {
  const f = fixture()
  const counters: LaunchCounters = { launches: 0, schedules: 0 }
  f.store.set(ownerExecutionLaunchApiAtom, startIntentApi(f.subject, counters))
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  await Promise.all([f.store.set(launchOwnerDeliveryAtom, { subject: f.subject, dispatchMode: 'autonomous', managed: true }), f.store.set(launchOwnerDeliveryAtom, { subject: f.subject, dispatchMode: 'autonomous', managed: true })])
  expect(flow(f).error).toContain('只允许通过Owner对话中的结果与范围确认')
  expect({ launches: counters.launches, schedules: counters.schedules }).toEqual({ launches: 0, schedules: 0 })
  expect(f.effects).toEqual({ materializations: 0, revalidations: 0 })
  expect(f.grantIssues()).toBe(0)
  expect(grants.getOwnerExecutionGrant(f.subject)).toBeNull()
  expect(db.listTasks(f.subject.projectId)).toHaveLength(0)
})
