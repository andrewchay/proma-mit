import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-materialization-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const plans = await import('./project-owner-plan-service')
const prep = await import('./project-owner-execution-preparation')
const policy = await import('./project-pilot-policy')
let service: typeof import('./project-owner-task-materialization')
beforeAll(async () => { await store.initProjectDb(); service = await import('./project-owner-task-materialization') })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(single = false, multi = true) {
  const project = store.createProject({ title: 'Owner材料化fixture', description: '' })
  const target = single ? store.createTask(project.id, { title: '保留现有标题', description: '保留现有说明' }) : null
  const workspace = createAgentWorkspace(`owner-materialization-${randomUUID()}`)
  bindWorkspaceToProject(project.id,workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const executor = employee('执行者'), reviewer = employee('技术评审')
  saveProjectOwnerGoalDraft(project.id,0,{ objective: '形成方案' },target?.id)
  const context = plans.getProjectOwnerPlanningContext(project.id,target?.id)
  const steps = [{ key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: context.sources.roles[0]!.key }, ...(multi ? [{ key: 'report', title: '汇总', outcome: '方案', acceptanceCriteria: ['有依据'], dependencies: ['brief'], roleKey: context.sources.roles[0]!.key }] : [])]
  plans.saveProjectOwnerPlanDraft(project.id,1,0,{ expectedContextFingerprint: context.fingerprint, summary: '形成方案', assumptions: [], risks: [], steps, changeReason: '建立计划' },target?.id)
  plans.confirmProjectOwnerPlanDraft(project.id,1,1,target?.id)
  const subject = { projectId: project.id, ...(target ? { taskId: target.id } : {}) }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step=>step.key), executionKind: 'controlled' as const, executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1000000, maxRuns: 2, maxRework: 0, expiresAt: Date.now()+3600000, changeReason: '暂停准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject,preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject,preparationInput,pv.previewFingerprint)
  const input = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  return { project, target, subject, input, preparation, executor, reviewer }
}
function count(table: string): number { return (store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {c:number}).c }
const restricted = () => ['agent_executions','pilot_runtime_grants','pilot_commands','pilot_request_reservations'].map(count)
function save(f: ReturnType<typeof fixture>) { const pv = service.previewOwnerTaskMaterialization(f.subject,f.input); return service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint) }

test('Given current项目准备 When 确认暂停落地 Then 每step真实Task+准确依赖，零许可/Run/请求', () => {
  const f = fixture(), baseline = restricted(), originalPolicy = policy.getPilotPolicy(f.project.id)
  const saved = save(f), tasks = store.listTasks(f.project.id)
  expect(saved.links).toHaveLength(2)
  expect(tasks).toHaveLength(2)
  for (const link of saved.links) { const task = store.getTask(link.taskId)!; expect(task.status).toBe('paused'); expect(task.ownerStepLinkId).toBe(link.id); expect(task.controlledPreparationId).toBeUndefined(); expect(task.assignee?.userId).toBe(`agent-${f.executor.id}`) }
  const edges = store.listTaskDependencies(f.project.id)
  expect(edges).toHaveLength(1)
  expect(edges[0]!.taskId).toBe(saved.links.find(link=>link.stepKey==='report')!.taskId)
  expect(edges[0]!.dependsOnTaskId).toBe(saved.links.find(link=>link.stepKey==='brief')!.taskId)
  expect(restricted()).toEqual(baseline)
  expect(policy.getPilotPolicy(f.project.id)).toEqual(originalPolicy)
  expect(service.getOwnerTaskMaterialization(f.subject).status).toBe('needs_revalidation')
})
test('Given 同请求 When 重试 Then 同一mapping不再建Task/dep/activity', () => {
  const f = fixture(), pv = service.previewOwnerTaskMaterialization(f.subject,f.input), saved = service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)
  const before = ['tasks','task_dependencies','project_activities'].map(count)
  expect(service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toEqual(saved)
  expect(['tasks','task_dependencies','project_activities'].map(count)).toEqual(before)
  expect(() => service.materializeOwnerTasks(f.subject,{...f.input,requestId:randomUUID()},pv.previewFingerprint)).toThrow('版本')
})
test('Given 单任务一步 When 人工确认人员/工作区patch Then 保留内容且原准备自然stale，不新建Task', () => {
  const f = fixture(true,false), before = count('tasks'), original = f.preparation
  const pv = service.previewOwnerTaskMaterialization(f.subject,f.input)
  expect(pv.projections[0]!.previous?.status).toBe('pending')
  const saved = service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)
  expect(count('tasks')).toBe(before)
  const task = store.getTask(f.target!.id)!
  expect(task.title).toBe('保留现有标题'); expect(task.description).toBe('保留现有说明'); expect(task.status).toBe('paused')
  expect(saved.links[0]!.taskId).toBe(task.id)
  expect(prep.getOwnerExecutionPreparation(f.subject).status).toBe('stale')
  expect(prep.listOwnerExecutionPreparationHistory(f.subject)[0]).toEqual(original)
  expect(service.getOwnerTaskMaterialization(f.subject).status).toBe('needs_revalidation')
  expect(service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toEqual(saved)
})
test('Given 单任务多step When 预览 Then 明确拒绝，不拆children或合并', () => {
  const f = fixture(true,true), before = count('tasks')
  expect(() => service.previewOwnerTaskMaterialization(f.subject,f.input)).toThrow('单任务')
  expect(count('tasks')).toBe(before)
})
test('Given Goal/目标/策略漂移 When 确认旧preview Then 零写入', () => {
  const f = fixture(), pv = service.previewOwnerTaskMaterialization(f.subject,f.input)
  saveProjectOwnerGoalDraft(f.project.id,1,{objective:'已变更目标'})
  const before = count('tasks')
  expect(() => service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toThrow('更新')
  expect(count('tasks')).toBe(before)
  expect(service.listOwnerTaskMaterializationHistory(f.subject)).toHaveLength(0)
})
test('Given 外层raw事务 When 保存 Then 拒绝，不把未提交当成功', () => {
  const f = fixture(), pv = service.previewOwnerTaskMaterialization(f.subject,f.input), db = store.getProjectDb()
  db.exec('BEGIN IMMEDIATE')
  try { expect(() => service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toThrow('外层事务') } finally { db.exec('ROLLBACK') }
  expect(store.listTasks(f.project.id)).toHaveLength(0)
})
test('Given DB ABORT When link最终写入失败 Then Task/deps/activity/header全rollback', () => {
  const f = fixture(), pv = service.previewOwnerTaskMaterialization(f.subject,f.input), db = store.getProjectDb()
  const before = ['tasks','task_dependencies','project_activities','project_owner_task_materializations','project_owner_task_step_links'].map(count)
  db.exec("CREATE TRIGGER owner_fixture_abort BEFORE UPDATE ON project_owner_task_step_links BEGIN SELECT RAISE(ABORT,'fixture'); END")
  try { expect(() => service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toThrow('fixture') } finally { db.exec('DROP TRIGGER owner_fixture_abort') }
  expect(['tasks','task_dependencies','project_activities','project_owner_task_materializations','project_owner_task_step_links'].map(count)).toEqual(before)
})
test('Given marker/link/Task损坏 When 重读/重试 Then 不降级或补造', () => {
  const f = fixture(), saved = save(f)
  store.getProjectDb().prepare('UPDATE project_owner_task_step_links SET payload=? WHERE id=?').run('broken',saved.links[0]!.id)
  expect(() => service.getOwnerTaskMaterialization(f.subject)).toThrow('保留原件')
  expect(store.hasOwnerBusinessTaskEvidence(saved.links[0]!.taskId)).toBe(true)
})

test('Given 用户只排序 When 读取 Then 不把updatedAt/列重编号当业务规格漂移', () => {
  const f = fixture(), saved = save(f), first = saved.links[0]!.taskId
  store.reorderTask(first,{ newStatusId:'paused' })
  expect(service.getOwnerTaskMaterialization(f.subject).status).toBe('needs_revalidation')
  expect(() => store.reorderTask(first,{ newStatusId:'pending' })).toThrow('Owner')
})
test('Given partial清marker/link但保留batch When 判断 Then 历史残余仍限制', () => {
  const f = fixture(), saved = save(f), id = saved.links[0]!.taskId, db = store.getProjectDb()
  db.prepare('UPDATE tasks SET owner_step_link_id=NULL WHERE id=?').run(id)
  db.prepare('DELETE FROM project_owner_task_step_links WHERE task_id=?').run(id)
  expect(store.hasOwnerBusinessTaskEvidence(id)).toBe(true)
  expect(() => store.createAgentExecution({id:randomUUID(),projectId:f.project.id,entityType:'task',entityId:id,agentId:'fake',sessionId:randomUUID(),prompt:'不能发',executor:'headless'})).toThrow('Owner')
  expect(() => service.getOwnerTaskMaterialization(f.subject)).toThrow('保留原件')
})
test('Given 相同提交后Goal漂移 When 重试历史请求 Then 返回原记录无重建、current单独stale', () => {
  const f = fixture(), pv = service.previewOwnerTaskMaterialization(f.subject,f.input), saved = service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint), before = count('tasks')
  saveProjectOwnerGoalDraft(f.project.id,1,{objective:'后续修订'})
  expect(service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toEqual(saved)
  expect(service.getOwnerTaskMaterialization(f.subject).status).toBe('stale')
  expect(count('tasks')).toBe(before)
})
test('Given single目标在预览后变更 When 提交 Then CAS拒绝且没有marker或关联', () => {
  const f = fixture(true,false), pv = service.previewOwnerTaskMaterialization(f.subject,f.input)
  store.updateTask(f.target!.id,{priority:'high'})
  expect(() => service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toThrow('更新')
  expect(store.getTask(f.target!.id)!.ownerStepLinkId).toBeUndefined()
})
test('Given native兼容SAVEPOINT/wrapper外层 When 保存 Then 前置拒绝且回滚无影子batch', () => {
  const f = fixture(), pv = service.previewOwnerTaskMaterialization(f.subject,f.input), db = store.getProjectDb()
  db.transaction(()=>{ expect(() => service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toThrow('外层事务') })()
  db.exec('SAVEPOINT owner_outer')
  try { expect(() => service.materializeOwnerTasks(f.subject,f.input,pv.previewFingerprint)).toThrow('外层事务') } finally { db.exec('ROLLBACK TO owner_outer'); db.exec('RELEASE owner_outer') }
  expect(service.listOwnerTaskMaterializationHistory(f.subject)).toHaveLength(0)
})
test('Given 单任务旧member身份 When 更换真实Agent Then 预览明确清除旧canonical键', () => {
  const f = fixture(true,false)
  // 先修订AO05以重新冻结人为新增的成员字段，不沿用旧source。
  store.updateTask(f.target!.id,{assigneeMemberId:'old-human-member'})
  const input = {...f.preparation.input,requestId:randomUUID(),expectedPreparationRevision:1,expectedPolicyRevision:f.preparation.policyRevision,changeReason:'目标身份字段已变更'}
  const prepPreview = prep.previewOwnerExecutionPreparation(f.subject,input), newPrep = prep.saveOwnerExecutionPreparation(f.subject,input,prepPreview.previewFingerprint)
  const materialInput = {...f.input,expectedPreparationId:newPrep.id,expectedPreparationRevision:newPrep.revision,expectedPreparationHash:newPrep.integrityHash,expectedPolicyRevision:newPrep.policyRevision}
  const pv = service.previewOwnerTaskMaterialization(f.subject,materialInput)
  expect(pv.projections[0]!.previous?.assigneeMemberId).toBe('old-human-member')
  expect(pv.projections[0]!.clearAssigneeMemberId).toBe(true)
  service.materializeOwnerTasks(f.subject,materialInput,pv.previewFingerprint)
  expect(store.getTask(f.target!.id)!.assigneeMemberId).toBeUndefined()
})
test('Given 权威库重开 When 读取 Then 精确任务/依赖和不可发行用途持久保留', async () => {
  const f = fixture(), saved = save(f)
  store.closeProjectDb(); await store.initProjectDb()
  expect(service.listOwnerTaskMaterializationHistory(f.subject)[0]).toEqual(saved)
  expect(service.getOwnerTaskMaterialization(f.subject).status).toBe('needs_revalidation')
  expect(policy.getPilotPolicy(f.project.id)?.state).toBe('paused')
})

test('Given committed link或已取消target When 新事务调用internal builder Then 拒重放/补造', () => {
  const f = fixture(true,false), saved = save(f)
  store.updateTask(f.target!.id,{status:'cancelled'})
  expect(() => store.getProjectDb().transaction(()=>{store.materializePausedOwnerTask(saved.links[0]!.id)})()).toThrow('Owner')
  expect(store.getTask(f.target!.id)!.status).toBe('cancelled')
  const created = fixture(), other = save(created)
  store.getProjectDb().prepare('DELETE FROM tasks WHERE id=?').run(other.links[0]!.taskId)
  expect(() => store.getProjectDb().transaction(()=>{store.materializePausedOwnerTask(other.links[0]!.id)})()).toThrow('Owner')
})
test('Given header丢失但indexed link存在 When 读取/preview Then 拒none与新plan隐式重复创建', () => {
  const f = fixture(), saved = save(f), db = store.getProjectDb()
  db.prepare('DELETE FROM project_owner_task_materializations WHERE id=?').run(saved.id)
  expect(() => service.getOwnerTaskMaterialization(f.subject)).toThrow('保留')
  expect(() => service.previewOwnerTaskMaterialization(f.subject,f.input)).toThrow('保留')
})
test('Given 原AO05证据丢失 When current诊断 Then 显式stale，不隐藏原来源缺口', () => {
  const f = fixture(), saved = save(f)
  store.getProjectDb().prepare('DELETE FROM project_owner_execution_preparations WHERE id=?').run(saved.preview.preparation.id)
  expect(service.getOwnerTaskMaterialization(f.subject).status).toBe('stale')
})
test('Given singleTask额外日期/优先级变化 When current诊断 Then 不遮盖合法patch之外漂移', () => {
  const f = fixture(true,false); save(f)
  store.getProjectDb().prepare("UPDATE tasks SET priority='high' WHERE id=?").run(f.target!.id)
  expect(service.getOwnerTaskMaterialization(f.subject).status).toBe('stale')
})

test('Given AO05原记录丢失但材料化残余 When 旧SourceGate消费 Then 拒绝退legacy', async () => {
  const f = fixture(), saved = save(f), evidence = await import('./project-owner-execution-preparation-evidence')
  store.getProjectDb().prepare('DELETE FROM project_owner_execution_preparations WHERE id=?').run(saved.preview.preparation.id)
  expect(evidence.hasOwnerExecutionPreparationEvidence(f.project.id)).toBe(true)
  expect(() => evidence.assertNoOwnerExecutionPreparation(f.project.id)).toThrow('Owner')
})
