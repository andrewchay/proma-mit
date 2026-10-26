import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectOwnerDeliveryContext } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-owner-plan-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
let commandFixture: Array<Omit<ProjectOwnerDeliveryContext, 'priorAuthorization'> & { grantAuthorization: ProjectOwnerDeliveryContext['priorAuthorization'] }> = []
mock.module('./project-owner-execution-command', () => ({ listOwnerExecutionCommands: () => commandFixture }))
const store = await import('./project-sqlite-store')
const goals = await import('./project-owner-goal-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function input() {
  return { summary: '先梳理定位并审阅成果', assumptions: [], risks: ['资料尚待核实'], changeReason: '首次整理提案', steps: [{ key: 'brief', title: '梳理需求', outcome: '可审阅需求简报', acceptanceCriteria: ['范围与排除项明确'], dependencies: [], roleKey: 'requirements-analyst' }] }
}

test('Given 已保存目标 When 保存与确认计划 Then 仅追加计划，零任务/执行/授权且目标版本不变', async () => {
  const service = await import('./project-owner-plan-service')
  const project = store.createProject({ title: '非代码Owner项目', description: '' })
  const goal = goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成可评审定位方案' })
  const tasks = store.listTasks(project.id).length
  const executions = (store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM agent_executions').get() as { n: number }).n
  const plan = service.saveProjectOwnerPlanDraft(project.id, goal.revision, 0, { ...input(), expectedContextFingerprint: service.getProjectOwnerPlanningContext(project.id).fingerprint })
  expect(plan).toMatchObject({ revision: 1, planVersion: 1, state: 'proposed', actor: 'local-user', goalVersion: 1 })
  const confirmed = service.confirmProjectOwnerPlanDraft(project.id, goal.revision, plan.revision)
  expect(confirmed).toMatchObject({ revision: 2, planVersion: 1, state: 'confirmed' })
  expect(goals.getProjectOwnerGoalDraft(project.id)).toEqual(goal)
  expect(store.listTasks(project.id)).toHaveLength(tasks)
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM agent_executions').get() as { n: number }).n).toBe(executions)
  expect(confirmed).not.toHaveProperty('grantId')
})

test('Given Task Goal中的交付反馈找不到同任务命令 When 读取规划上下文 Then 拒绝丢失交付来源后继续规划', async () => {
  const service = await import('./project-owner-plan-service')
  const project = store.createProject({ title: '交付反馈来源核验', description: '' })
  const task = store.createTask(project.id, { title: '目标任务', description: '验证原交付' })
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '补充交付验证', constraints: ['Owner交付修改意见（命令 missing-command）：补充零值用例'] }, task.id)
  expect(() => service.getProjectOwnerPlanningContext(project.id, task.id)).toThrow('交付修改意见关联的Owner命令已缺失')
})

test('Given Task Goal交付标记格式损坏或命令重复 When读取规划上下文 Then fail closed不静默丢弃修改意见', async () => {
  const service = await import('./project-owner-plan-service')
  const project = store.createProject({ title: '交付标记损坏', description: '' })
  const task = store.createTask(project.id, { title: '目标任务', description: '核验反馈来源' })
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '补充验证', constraints: ['Owner交付修改意见坏格式'] }, task.id)
  expect(() => service.getProjectOwnerPlanningContext(project.id, task.id)).toThrow('交付修改意见标记格式损坏')

  const duplicateProject = store.createProject({ title: '交付标记重复', description: '' })
  const duplicateTask = store.createTask(duplicateProject.id, { title: '目标任务', description: '核验反馈唯一性' })
  goals.saveProjectOwnerGoalDraft(duplicateProject.id, 0, { objective: '补充验证', constraints: [
    'Owner交付修改意见（命令 duplicate-command）：意见A', 'Owner交付修改意见（命令 duplicate-command）：意见B',
  ] }, duplicateTask.id)
  commandFixture = [{ commandId: 'duplicate-command', grantId: 'grant-duplicate', grantAuthorization: { grantState: 'active', dispatchMode: 'manual', maxCostMicros: 1000000, maxRuns: 2, maxRework: 0, expiresAt: 9999999999999, roleBudgetCaps: [] },
    taskId: duplicateTask.id, role: 'executor', reworkOrdinal: 0, state: 'settled', acceptanceCriteria: ['标准'], feedback: '账本反馈' }]
  expect(() => service.getProjectOwnerPlanningContext(duplicateProject.id, duplicateTask.id)).toThrow('重复关联同一命令')
  commandFixture = []
})

test('Given Task Goal反馈精确绑定已有命令 When读取规划上下文 Then冻结交付与评审进入指纹来源', async () => {
  const service = await import('./project-owner-plan-service')
  const project = store.createProject({ title: '交付来源绑定', description: '' })
  const task = store.createTask(project.id, { title: '报价修复', description: '修复边界并保持正常行为' })
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '补充边界验证', constraints: ['Owner交付修改意见（命令 command-1）：增加零值验证'] }, task.id)
  commandFixture = [{ commandId: 'command-1', grantId: 'grant-1', grantAuthorization: { grantState: 'active', dispatchMode: 'manual', maxCostMicros: 1000000, maxRuns: 3, maxRework: 1, expiresAt: 9999999999999, roleBudgetCaps: [{ roleKey: 'executor', maxCostMicros: 500000 }] }, taskId: task.id, role: 'executor', reworkOrdinal: 0, state: 'settled',
    acceptanceCriteria: ['正常数量行为不变'], executionResultSummary: '执行者自述：完成修改',
    technicalReview: { verdict: 'changes_requested', summary: '缺少零值覆盖', criteria: [{ criterion: '正常数量行为不变', status: 'met', evidence: '回归样例' }], findings: [{ severity: 'medium', description: '未覆盖零值', requestedChange: '增加零值用例' }], blockerReason: null }, feedback: '命令表替身反馈' }]
  const context = service.getProjectOwnerPlanningContext(project.id, task.id)
  const { grantAuthorization, ...deliveryFixture } = commandFixture[0]!
  expect(context.sources.delivery).toEqual([{ ...deliveryFixture, priorAuthorization: grantAuthorization, feedback: '增加零值验证' }])
  const firstFingerprint = context.fingerprint
  commandFixture = [{ ...commandFixture[0]!, executionResultSummary: '执行者自述：其它回报' }]
  expect(service.getProjectOwnerPlanningContext(project.id, task.id).fingerprint).not.toBe(firstFingerprint)
  commandFixture = []
})

test('Given 反馈规划带完整命令差异 When保存并重读 Then逐项授权评估参与持久计划指纹', async () => {
  const service = await import('./project-owner-plan-service')
  const project = store.createProject({ title: '交付差异持久化', description: '' })
  const task = store.createTask(project.id, { title: '边界修复', description: '原交付任务' })
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '补充边界验证', constraints: ['Owner交付修改意见（命令 command-2）：增加零值验证'] }, task.id)
  commandFixture = [{ commandId: 'command-2', grantId: 'grant-2', grantAuthorization: { grantState: 'active', dispatchMode: 'manual', maxCostMicros: 1000000, maxRuns: 3, maxRework: 1, expiresAt: 9999999999999, roleBudgetCaps: [{ roleKey: 'executor', maxCostMicros: 500000 }] }, taskId: task.id, role: 'executor', reworkOrdinal: 0, state: 'settled', acceptanceCriteria: ['保持正常数量行为'], feedback: '增加零值验证' }]
  const context = service.getProjectOwnerPlanningContext(project.id, task.id)
  const deliveryChangeAssessment = { summary: '增加零值回归验证', commands: [{ commandId: 'command-2', changes: [{ criterion: '保持正常数量行为', disposition: 'addressed' as const, proposedChange: '增加零值与正常数量回归测试' }], authorizationImpact: 'unchanged' as const, authorizationRationale: '只补本地验证，不改执行范围' }] }
  const saved = service.saveProjectOwnerPlanDraft(project.id, context.goal.revision, 0, { ...input(), expectedContextFingerprint: context.fingerprint, deliveryChangeAssessment }, task.id)
  expect(saved.proposal.deliveryChangeAssessment).toEqual(deliveryChangeAssessment)
  expect(service.getProjectOwnerPlanDraft(project.id, task.id)?.proposal.deliveryChangeAssessment).toEqual(deliveryChangeAssessment)
  commandFixture = []
})

const plans = await import('./project-owner-plan-service')
const catalog = await import('./project-owner-role-catalog')
const { getWorkflowIdentityDirectoryPath } = await import('./config-paths')
function fixture(taskId?: string, projectId?: string) {
  const p = projectId ? store.getProject(projectId)! : store.createProject({ title: 'Owner计划夹具', description: '原始项目来源' })
  const goal = goals.saveProjectOwnerGoalDraft(p.id, 0, { objective: '可评审成果' }, taskId)
  const context = plans.getProjectOwnerPlanningContext(p.id, taskId)
  const plan = plans.saveProjectOwnerPlanDraft(p.id, goal.revision, 0, { ...input(), expectedContextFingerprint: context.fingerprint }, taskId)
  return { p, goal, context, plan }
}
function saveInput(projectId: string, taskId?: string) {
  return { ...input(), expectedContextFingerprint: plans.getProjectOwnerPlanningContext(projectId, taskId).fingerprint }
}
function rows(projectId: string): number {
  return (store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_plan_revisions WHERE project_id = ?').get(projectId) as { n: number }).n
}

test('无目标可以空读但不可规划保存，缺项目和跨项目主体拒绝', () => {
  const p = store.createProject({ title: '无目标', description: '' })
  expect(plans.getProjectOwnerPlanDraft(p.id)).toBeNull()
  expect(plans.listProjectOwnerPlanHistory(p.id)).toEqual([])
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 0, input())).toThrow('请先保存')
  expect(() => plans.getProjectOwnerPlanDraft('missing')).toThrow()
  const other = store.createProject({ title: '另一项目', description: '' })
  const task = store.createTask(other.id, { title: '另一项目任务', description: '' })
  expect(() => plans.getProjectOwnerPlanningContext(p.id, task.id)).toThrow('不属于')
  expect(rows(p.id)).toBe(0)
})

test('项目/两个单任务计划修订相互隔离，角色只是建议不是员工', () => {
  const p = store.createProject({ title: '多主体', description: '' })
  const first = store.createTask(p.id, { title: 'A', description: '' })
  const second = store.createTask(p.id, { title: 'B', description: '' })
  fixture(undefined, p.id); fixture(first.id, p.id); fixture(second.id, p.id)
  const a = plans.getProjectOwnerPlanDraft(p.id, first.id)!
  plans.confirmProjectOwnerPlanDraft(p.id, 1, a.revision, first.id)
  expect(plans.getProjectOwnerPlanDraft(p.id)?.revision).toBe(1)
  expect(plans.getProjectOwnerPlanDraft(p.id, second.id)?.state).toBe('proposed')
  expect(plans.getProjectOwnerPlanDraft(p.id, first.id)?.revision).toBe(2)
  expect(a.proposal).toMatchObject({ taskId: first.id, mode: 'proposal_only' })
  expect(a.proposal.steps[0]).not.toHaveProperty('employeeId')
  expect(plans.getProjectOwnerPlanningContext(p.id).sources.roles[0]).not.toHaveProperty('systemPrompt')
})

test('同内容合法版本no-op，旧计划/目标版本即使同内容也冲突，不盲重试', () => {
  const { p, plan } = fixture()
  expect(plans.saveProjectOwnerPlanDraft(p.id, 1, 1, saveInput(p.id))).toEqual(plan)
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 0, saveInput(p.id))).toThrow(plans.ProjectOwnerPlanConflictError)
  expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 2, 1)).toThrow(plans.ProjectOwnerPlanConflictError)
  const confirmed = plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)
  expect(plans.confirmProjectOwnerPlanDraft(p.id, 1, 2)).toEqual(confirmed)
  expect(plans.saveProjectOwnerPlanDraft(p.id, 1, 2, saveInput(p.id)).state).toBe('confirmed')
  expect(rows(p.id)).toBe(2)
})

test('确认后实质修订必须有原因，新planVersion回到proposed，不能沿用验收', () => {
  const { p } = fixture()
  plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 2, { ...saveInput(p.id), summary: '新方案', changeReason: '' })).toThrow()
  const changed = plans.saveProjectOwnerPlanDraft(p.id, 1, 2, { ...saveInput(p.id), summary: '新方案', changeReason: '调整成果顺序' })
  expect(changed).toMatchObject({ revision: 3, planVersion: 2, state: 'proposed' })
  expect(plans.listProjectOwnerPlanHistory(p.id).map((r) => r.state)).toEqual(['proposed', 'confirmed', 'proposed'])
  expect(goals.getProjectOwnerGoalDraft(p.id)?.revision).toBe(1)
})

test('目标改变使计划派生stale，历史确认仍保留但晚到输出和旧确认拒绝', () => {
  const { p, context } = fixture()
  plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)
  goals.saveProjectOwnerGoalDraft(p.id, 1, { objective: '调整后目标' })
  expect(plans.getProjectOwnerPlanDraft(p.id)).toMatchObject({ state: 'stale', planVersion: 1, goalVersion: 1 })
  expect(plans.listProjectOwnerPlanHistory(p.id)[1]?.state).toBe('confirmed')
  expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 2, 2)).toThrow(plans.ProjectOwnerPlanConflictError)
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 2, { ...input(), expectedContextFingerprint: context.fingerprint })).toThrow(plans.ProjectOwnerPlanConflictError)
  const fresh = plans.saveProjectOwnerPlanDraft(p.id, 2, 2, saveInput(p.id))
  expect(fresh).toMatchObject({ state: 'proposed', planVersion: 2, goalVersion: 2, goalRevision: 2 })
})

test('项目/任务来源修改但目标修订未变，旧来源指纹输出不得偷偷绑定新来源', () => {
  const { p, context } = fixture()
  store.updateProject(p.id, { description: '新的来源说明' })
  expect(plans.getProjectOwnerPlanDraft(p.id)?.state).toBe('stale')
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 1, { ...input(), expectedContextFingerprint: context.fingerprint })).toThrow(plans.ProjectOwnerPlanConflictError)
  expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)).toThrow(plans.ProjectOwnerPlanConflictError)
  expect(plans.saveProjectOwnerPlanDraft(p.id, 1, 1, saveInput(p.id))).toMatchObject({ planVersion: 2, state: 'proposed' })
  const task = store.createTask(p.id, { title: '原任务', description: '' }); fixture(task.id, p.id)
  store.updateTask(task.id, { description: '新的任务资料' })
  expect(plans.getProjectOwnerPlanDraft(p.id, task.id)?.state).toBe('stale')
})

test('岗位规则变更使当前提案失效，历史用原岗位快照可读且不重写', () => {
  const { p } = fixture()
  const original = catalog.getProjectOwnerRoleAdviceCatalog()
  const spy = spyOn(catalog, 'getProjectOwnerRoleAdviceCatalog').mockImplementation(() => original.map((role, i) => i ? role : { ...role, rulesSha256: 'a'.repeat(64) }))
  try {
    expect(plans.getProjectOwnerPlanDraft(p.id)?.state).toBe('stale')
    expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)).toThrow(plans.ProjectOwnerPlanConflictError)
    expect(plans.listProjectOwnerPlanHistory(p.id)).toHaveLength(1)
  } finally { spy.mockRestore() }
})

test('计划与步骤未知授权字段、不可用岗位、跨主体/伪造版本和循环依赖全部拒绝', () => {
  const { p } = fixture()
  for (const forbidden of ['actor', 'grantId', 'permissionMode', 'status', 'goalVersion', 'projectId', 'taskId', 'planVersion', 'mode', 'deliveryFeedbackAssessment']) {
    expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 1, { ...saveInput(p.id), [forbidden]: 'fake' })).toThrow('未知字段')
  }
  const base = saveInput(p.id)
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 1, { ...base, steps: [{ ...base.steps[0], employeeId: 'fake' }] })).toThrow('未知字段')
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 1, { ...base, steps: [{ ...base.steps[0], roleKey: 'invented-role' }] })).toThrow('不可用角色')
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 1, { ...base, steps: [{ ...base.steps[0], dependencies: ['brief'] }] })).toThrow('自身')
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 1, { ...base, steps: [] })).toThrow()
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, NaN, 1, base)).toThrow()
  expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, -1, base)).toThrow()
  expect(rows(p.id)).toBe(1)
})

test('停用/损坏/重复的本机身份目录不能确认或修订，不回退为默认启用', () => {
  const { p } = fixture(); const path = getWorkflowIdentityDirectoryPath()
  try {
    for (const directory of [
      { users: [{ id: 'local-user', enabled: false }], roles: [] },
      { users: [{ id: 'local-user', enabled: true }, { id: 'local-user', enabled: false }] },
      { users: [{ id: 'local-user', enabled: 'yes' }] },
      { users: [] },
    ]) {
      writeFileSync(path, JSON.stringify(directory))
      expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)).toThrow()
      expect(() => plans.saveProjectOwnerPlanDraft(p.id, 1, 1, saveInput(p.id))).toThrow()
    }
    writeFileSync(path, '{broken')
    expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)).toThrow('目录不可读')
    expect(rows(p.id)).toBe(1)
  } finally { unlinkSync(path) }
})

test('外层事务回滚不留提案或确认，返回副本修改不污染当前历史', () => {
  const { p, plan } = fixture()
  expect(() => store.getProjectDb().transaction(() => { plans.confirmProjectOwnerPlanDraft(p.id, 1, 1); throw new Error('rollback') })()).toThrow('rollback')
  expect(plans.getProjectOwnerPlanDraft(p.id)?.state).toBe('proposed')
  plan.proposal.steps[0]!.title = '篡改副本'
  plan.sources.roles[0]!.name = '篡改岗位快照'
  expect(plans.getProjectOwnerPlanDraft(p.id)?.proposal.steps[0]?.title).toBe('梳理需求')
  const other = store.createProject({ title: '回滚首次', description: '' })
  goals.saveProjectOwnerGoalDraft(other.id, 0, { objective: '回滚初始提案' })
  expect(() => store.getProjectDb().transaction(() => { plans.saveProjectOwnerPlanDraft(other.id, 1, 0, saveInput(other.id)); throw new Error('rollback') })()).toThrow()
  expect(plans.getProjectOwnerPlanDraft(other.id)).toBeNull()
})

test('数据库重开保留确认及原目标，不因confirmed自动启动', async () => {
  const { p } = fixture(); plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)
  store.closeProjectDb(); await store.initProjectDb()
  expect(plans.getProjectOwnerPlanDraft(p.id)).toMatchObject({ revision: 2, state: 'confirmed' })
  expect(plans.listProjectOwnerPlanHistory(p.id)).toHaveLength(2)
  expect(goals.getProjectOwnerGoalDraft(p.id)?.goal.goalVersion).toBe(1)
  expect(store.listTasks(p.id)).toHaveLength(0)
})

test('删除主体后保留附属历史但拒绝继续读写，计划不会复活', () => {
  const { p } = fixture()
  const task = store.createTask(p.id, { title: '待删除任务', description: '' }); fixture(task.id, p.id)
  store.deleteTask(task.id)
  expect(() => plans.getProjectOwnerPlanDraft(p.id, task.id)).toThrow()
  expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 1, 1, task.id)).toThrow()
  store.deleteProject(p.id)
  expect(() => plans.listProjectOwnerPlanHistory(p.id)).toThrow()
  expect(rows(p.id)).toBe(2)
})

test('损坏JSON、来源/主体/模式/历史目标引用拒绝，不补造有效提案', () => {
  const { p, plan } = fixture()
  const patch = (payload: string) => store.getProjectDb().prepare('UPDATE project_owner_plan_revisions SET payload = ? WHERE project_id = ?').run(payload, p.id)
  for (const value of [
    { ...plan, projectId: 'other' }, { ...plan, revision: 9 }, { ...plan, goalRevision: 99 },
    { ...plan, contextFingerprint: '0'.repeat(64) }, { ...plan, grantId: 'fake' },
    { ...plan, proposal: { ...plan.proposal, mode: 'execute' } }, { ...plan, actor: 'model' },
  ]) {
    patch(JSON.stringify(value))
    expect(() => plans.getProjectOwnerPlanDraft(p.id)).toThrow('记录格式无效')
    expect(() => plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)).toThrow('记录格式无效')
  }
  patch('{broken')
  expect(() => plans.getProjectOwnerPlanDraft(p.id)).toThrow('记录格式无效')
  expect(rows(p.id)).toBe(1)
})

test('原项目/任务/目标在老库加计划表后保留，数据库重复版本/非正版本拒绝', async () => {
  const p = store.createProject({ title: '旧库兼容', description: '' }); const task = store.createTask(p.id, { title: '旧任务', description: '' })
  goals.saveProjectOwnerGoalDraft(p.id, 0, { objective: '旧目标' })
  store.getProjectDb().exec('DROP TABLE project_owner_plan_revisions')
  store.closeProjectDb(); await store.initProjectDb()
  expect(store.getProject(p.id)?.title).toBe('旧库兼容')
  expect(store.getTask(task.id)?.id).toBe(task.id)
  expect(goals.getProjectOwnerGoalDraft(p.id)?.revision).toBe(1)
  const plan = plans.saveProjectOwnerPlanDraft(p.id, 1, 0, saveInput(p.id))
  const insert = store.getProjectDb().prepare('INSERT INTO project_owner_plan_revisions (project_id, subject_key, revision, payload) VALUES (?, ?, ?, ?)')
  expect(() => insert.run(p.id, 'project', 1, JSON.stringify(plan))).toThrow()
  expect(() => insert.run(p.id, 'project', 0, '{}')).toThrow()
})


test('伪造首版确认、同版本改内容确认、删除历史造成缺口均拒绝，不把损坏状态当授权依据', () => {
  const { p, plan } = fixture()
  const patch = (revision: number, payload: unknown) => store.getProjectDb().prepare('UPDATE project_owner_plan_revisions SET payload = ? WHERE project_id = ? AND revision = ?').run(JSON.stringify(payload), p.id, revision)
  patch(1, { ...plan, state: 'confirmed' })
  expect(() => plans.getProjectOwnerPlanDraft(p.id)).toThrow('历史转换无效')
  patch(1, plan)
  const confirmed = plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)
  patch(2, { ...confirmed, proposal: { ...confirmed.proposal, summary: '绕过修订更改内容' } })
  expect(() => plans.getProjectOwnerPlanDraft(p.id)).toThrow('记录格式无效')
  patch(2, confirmed)
  store.getProjectDb().prepare('DELETE FROM project_owner_plan_revisions WHERE project_id = ? AND revision = 1').run(p.id)
  expect(() => plans.listProjectOwnerPlanHistory(p.id)).toThrow('历史转换无效')
})

test('保存与确认不触发项目链/任务事件，来源读取不会暗中创建执行与费用权威', async () => {
  const { p } = fixture()
  const { onTaskChange } = await import('./project-service')
  const { onProjectChainChange } = await import('./project-chain-service')
  const events: string[] = []
  const removeTasks = onTaskChange(() => events.push('task'))
  const removeChain = onProjectChainChange(() => events.push('chain'))
  const tables = ['tasks', 'agent_executions', 'pilot_intents', 'pilot_commands', 'pilot_runtime_grants', 'project_chain_revisions']
  const count = (table: string) => store.getProjectDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
  const before = tables.map(count)
  try {
    plans.confirmProjectOwnerPlanDraft(p.id, 1, 1)
    plans.saveProjectOwnerPlanDraft(p.id, 1, 2, { ...saveInput(p.id), summary: '修订成果建议' })
    plans.getProjectOwnerPlanningContext(p.id)
    await Promise.resolve()
    expect(tables.map(count)).toEqual(before)
    expect(events).toEqual([])
  } finally { removeTasks(); removeChain() }
})

test('Given 项目绑定启用知识库 When 规划与保存 Then 冻结来源身份、不泄露路径、停用后指纹变化且历史可读', async () => {
  const catalog = await import('./knowledge-catalog-service')
  const service = await import('./project-owner-plan-service')
  const project = store.createProject({ title: '知识资料规划', description: '' })
  goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '基于已授权PDF形成方案', codeSourceAccess: 'none' })
  const initial = service.getProjectOwnerPlanningContext(project.id)
  expect(initial.sources.knowledgeSources).toBeUndefined()
  const source = catalog.createSource({ type: 'vault', name: '逐页PDF', locator: join(directory, 'private-pdf'), enabled: true })
  const disabled = catalog.createSource({ type: 'vault', name: '禁用资料', locator: join(directory, 'disabled-pdf'), enabled: false })
  const unbound = catalog.createSource({ type: 'vault', name: '其他项目资料', locator: join(directory, 'unbound-pdf'), enabled: true })
  const base = catalog.createKnowledgeBase({ name: '项目资料', sourceIds: [source.id, disabled.id] })
  catalog.createKnowledgeBase({ name: '未绑定', sourceIds: [unbound.id] })
  catalog.bindProject({ projectId: project.id, knowledgeBaseId: base.id })
  const context = service.getProjectOwnerPlanningContext(project.id)
  expect(context.sources.knowledgeSources).toEqual([{ id: source.id, name: '逐页PDF' }])
  expect(JSON.stringify(context.sources)).not.toContain('private-pdf')
  expect(context.sources.code).toBeUndefined()
  expect(context.fingerprint).not.toBe(initial.fingerprint)
  const plan = service.saveProjectOwnerPlanDraft(project.id, 1, 0, { ...input(), expectedContextFingerprint: context.fingerprint })
  expect(service.getProjectOwnerPlanDraft(project.id)?.sources).toEqual(plan.sources)
  catalog.updateKnowledgeBase(base.id, { enabled: false })
  expect(service.getProjectOwnerPlanningContext(project.id).fingerprint).toBe(initial.fingerprint)
  expect(service.getProjectOwnerPlanDraft(project.id)?.sources.knowledgeSources).toEqual([{ id: source.id, name: '逐页PDF' }])
})
