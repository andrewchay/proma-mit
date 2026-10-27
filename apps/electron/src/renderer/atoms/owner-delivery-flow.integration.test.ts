import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from 'jotai'
import type { ProjectOwnerGoalResult } from '@gravitas/shared'
import { buildElectronMock } from '../../main/lib/testing/electron-mock'
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from './project-owner-goal-atoms'
import { getOwnerPlanEditor, ownerPlanEditorsAtom } from './project-owner-plan-atoms'
import { getOwnerExecutionEditor, ownerExecutionApiAtom, ownerExecutionEditorsAtom } from './project-owner-execution-atoms'
import { getOwnerTaskEditor, ownerTaskApiAtom, ownerTaskEditorsAtom, ownerTaskRefreshAtom } from './project-owner-task-atoms'
import { ownerRevalidationApiAtom, getOwnerRevalidationEditor, ownerRevalidationEditorsAtom } from './project-owner-execution-revalidation-atoms'
import { ownerGrantApiAtom } from './project-owner-execution-grant-atoms'
import { confirmOwnerDeliveryTasksAtom, continueOwnerDeliveryRevalidationAtom, getOwnerDeliveryFlow, loadOwnerDeliveryFlowAtom, ownerDeliveryFlowsAtom } from './owner-delivery-flow-atoms'

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
beforeAll(async () => { await db.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); db.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
const subjectOf = (r: { projectId: string; taskId?: string }) => ({ projectId: r.projectId, ...(r.taskId ? { taskId: r.taskId } : {}) })
async function response<T>(run: () => T): Promise<ProjectOwnerGoalResult<T>> {
  try { return { ok: true, value: run() } }
  catch (cause) { return { ok: false, error: { code: 'conflict', message: cause instanceof Error ? cause.message : '失败' } } }
}
function fixture() {
  const store = createStore(), project = db.createProject({ title: '连续交付', description: '' }), subject = { projectId: project.id }, key = JSON.stringify([project.id, null])
  const workspace = createAgentWorkspace(`delivery-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake-only', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'glm-5.3-flash', name: '测试', enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'glm-5.3-flash', workspaceIds: [workspace.id] })
  const executor = employee('研究'), reviewer = employee('评审')
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
  let failValidation = false, loseReply = false
  store.set(ownerExecutionApiAtom, { getOwnerExecutionPreparation: s => response(() => prep.getOwnerExecutionPreparation(s)), listOwnerExecutionPreparationHistory: async () => ({ ok: true, value: [] }), previewOwnerExecutionPreparation: async () => { throw Error('不应重新准备') }, saveOwnerExecutionPreparation: async () => { throw Error('不应重新准备') } })
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
  store.set(ownerGrantApiAtom, { getOwnerExecutionGrant: s => response(() => grants.getOwnerExecutionGrant(s)), listOwnerExecutionGrantHistory: async () => ({ ok: true, value: [] }), previewOwnerExecutionGrantIssue: async () => { throw Error('不应自动请求授权') }, confirmOwnerExecutionGrantIssue: async () => { throw Error('不应自动发行授权') }, previewOwnerExecutionGrantRevoke: async () => { throw Error('不应撤权') }, confirmOwnerExecutionGrantRevoke: async () => { throw Error('不应撤权') } })
  return { store, subject, preparation, effects, failValidation: () => { failValidation = true }, loseReply: () => { loseReply = true } }
}
const flow = (f: ReturnType<typeof fixture>) => getOwnerDeliveryFlow(f.store.get(ownerDeliveryFlowsAtom), f.subject)
const taskEditor = (f: ReturnType<typeof fixture>) => getOwnerTaskEditor(f.store.get(ownerTaskEditorsAtom), f.subject)

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
browserTest('Given真实任务服务 When登记、人工授权、自动读取合成交付并反馈 Then同页推进且反馈不保存或扩权', async () => {
  const f = fixture(), renderer = resolve(import.meta.dir, '..'), root = resolve(import.meta.dir, '../../../../..')
  const goal = getOwnerGoalEditor(f.store.get(ownerGoalEditorsAtom), f.subject).snapshot
  const plan = getOwnerPlanEditor(f.store.get(ownerPlanEditorsAtom), f.subject)
  const execution = getOwnerExecutionEditor(f.store.get(ownerExecutionEditorsAtom), f.subject)
  const seed = { subject: f.subject, goal, plan: plan.snapshot, context: plan.context, preparation: execution.view }
  let delivered: OwnerExecutionCommandView[] = [], commandReads = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/entry.js') return new Response(Bun.file(join(directory, 'browser.js')))
    if (path !== '/api') return new Response('<html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } })
    const raw: unknown = await request.json()
    if (!raw || typeof raw !== 'object') return Response.json({ ok: false })
    const { method, payload } = raw as { method: string; payload: Record<string, unknown> }
    const subject = { projectId: payload.projectId, ...(payload.taskId ? { taskId: payload.taskId } : {}) }
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
          delivered = [{ commandId: 'synthetic-delivery', grantId: grant.grantId, taskId: task.id, taskTitle: task.title, employeeId: grant.executorEmployeeId, role: 'executor', reworkOrdinal: 0, state: 'settled', executionId: 'synthetic-run', executionStatus: 'completed', executionResultSummary: '合成回报：定位报告待人工审阅', acceptanceCriteria: ['来源明确'], reservedCostMicros: 100, actualCostMicros: null, grantAuthorization: { grantState: 'active', dispatchMode: 'manual', ...grant.budget, roleBudgetCaps: [] }, ackFingerprint: 'synthetic', createdAt: 1, updatedAt: 2 }]
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
const seed=${JSON.stringify(seed)},subject=seed.subject,key=JSON.stringify([subject.projectId,null]);
const call=async(method,payload=subject)=>(await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,payload})})).json();
const names=['getOwnerTaskMaterialization','listOwnerTaskMaterializationHistory','previewOwnerTaskMaterialization','materializeOwnerTasks','getOwnerExecutionPreparation','listOwnerExecutionPreparationHistory','previewOwnerExecutionPreparation','saveOwnerExecutionPreparation','getOwnerExecutionRevalidation','listOwnerExecutionRevalidationHistory','previewOwnerExecutionRevalidation','saveOwnerExecutionRevalidation','getOwnerExecutionGrant','listOwnerExecutionGrantHistory','previewOwnerExecutionGrantIssue','confirmOwnerExecutionGrantIssue','previewOwnerExecutionGrantRevoke','confirmOwnerExecutionGrantRevoke','listOwnerExecutionCommands','getOwnerAutonomousScheduleStatus','previewOwnerExecutionCommandAck','queueOwnerExecutionCommand','dispatchOwnerExecutionCommand','cancelQueuedOwnerExecutionCommand','previewOwnerPreflightReconciliation','confirmOwnerPreflightReconciliation','getOwnerGoalDraft','saveOwnerGoalDraft'];
window.electronAPI={listChannels:async()=>[],listAgentWorkspaces:async()=>[],paa:{project:{...Object.fromEntries(names.map(name=>[name,payload=>call(name,payload)])),listTasks:async()=>[],getOwnerRuntimeBinding:async()=>({ok:true,value:null})},agentEmployees:{list:async()=>[]},projectWorkspace:{listByProject:async()=>[]}}};
const store=createStore();store.set(ownerGoalEditorsAtom,new Map([[key,{...getOwnerGoalEditor(new Map(),subject),loaded:true,snapshot:seed.goal}]]));store.set(ownerPlanEditorsAtom,new Map([[key,{...getOwnerPlanEditor(new Map(),subject),loaded:true,snapshot:seed.plan,context:seed.context}]]));store.set(ownerExecutionEditorsAtom,new Map([[key,{...getOwnerExecutionEditor(new Map(),subject),loaded:true,view:seed.preparation}]]));
window.fixture={deliver:()=>call('testDeliver'),draft:taskId=>getOwnerGoalEditor(store.get(ownerGoalEditorsAtom),{...subject,taskId})};
createRoot(document.getElementById('root')).render(<Provider store={store}><ProjectOwnerDeliveryConversation projectId={subject.projectId}/></Provider>);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 390, height: 800 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.clock.install()
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByRole('button', { name: '确认登记这些任务并核验范围', exact: true }).click()
    await page.getByRole('button', { name: '查看本次执行授权摘要', exact: true }).click()
    expect(grants.getOwnerExecutionGrant(f.subject)).toBeNull()
    await page.getByRole('button', { name: '确认授权，采用逐条启动', exact: true }).click()
    await page.getByText('执行授权：active', { exact: false }).waitFor()
    expect(grants.getOwnerExecutionGrant(f.subject)?.dispatchMode).toBe('manual')
    expect((db.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_execution_commands').get() as { count: number }).count).toBe(0)
    await page.evaluate('window.fixture.deliver()')
    await page.clock.fastForward(4100)
    await page.getByText('合成交付已就绪', { exact: false }).waitFor()
    await page.getByText('交付审阅材料（只读）', { exact: true }).click()
    await page.getByLabel('针对本交付提出修改意见').fill('需要补充对照来源')
    await page.getByRole('button', { name: '加入对应Task的Goal草案', exact: true }).click()
    await page.getByRole('dialog', { name: '按交付反馈调整目标', exact: true }).waitFor()
    expect(await page.getByRole('dialog').getByLabel('希望达成的目标').inputValue()).toBe(delivered[0]!.taskTitle)
    expect(goals.getProjectOwnerGoalDraft(f.subject.projectId, delivered[0]!.taskId)).toBeNull()
    expect(grants.listOwnerExecutionGrantHistory(f.subject)).toHaveLength(1)
    expect(commandReads).toBeGreaterThan(1)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)

test('Given首次加载瞬态遗留需要比较 When当前来源已稳定 Then仅重建新摘要、不自动登记', async () => {
  const f = fixture(), key = JSON.stringify([f.subject.projectId, null])
  f.store.set(ownerTaskEditorsAtom, new Map([[key, { ...getOwnerTaskEditor(new Map(), f.subject), requiresReview: true }]]))
  await f.store.set(loadOwnerDeliveryFlowAtom, f.subject)
  expect(taskEditor(f).preview?.projections).toHaveLength(2)
  expect(taskEditor(f).requiresReview).toBe(false)
  expect(f.effects).toEqual({ materializations: 0, revalidations: 0 })
})
