import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-execution-prep-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
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
const catalog = await import('./knowledge-catalog-service')
const { getWorkspaceSkillsDir } = await import('./config-paths')
const bindings = await import('./project-owner-runtime-binding')
const policy = await import('./project-pilot-policy')
const grants = await import('./project-pilot-grant-issue')
afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})
let service: typeof import('./project-owner-execution-preparation')
beforeAll(async () => {
  await store.initProjectDb()
  service = await import('./project-owner-execution-preparation')
})
function fixture(confirm = true) {
  const project = store.createProject({ title: 'Owner执行准备', description: '' })
  const workspace = createAgentWorkspace(`Owner-execution-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({
    name: '离线假渠道',
    provider: 'openai',
    baseUrl: 'https://example.invalid',
    apiKey: 'fake',
    enabled: true,
    models: [{ id: 'model', name: 'model', enabled: true }],
  })
  const employee = (name: string) =>
    employees.createAgentEmployee({
      name,
      role: '研究',
      description: '',
      executionProfile: 'controlled',
      permissionMode: 'safe',
      runtime: 'ai-sdk',
      channelId: channel.id,
      modelId: 'model',
      workspaceIds: [workspace.id],
    })
  const executor = employee('执行者'),
    reviewer = employee('评审者')
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成定位方案' })
  const context = plans.getProjectOwnerPlanningContext(project.id)
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, {
    expectedContextFingerprint: context.fingerprint,
    summary: '定位研究',
    assumptions: [],
    risks: [],
    steps: [
      {
        key: 'brief',
        title: '研究',
        outcome: '方案',
        acceptanceCriteria: ['范围明确'],
        dependencies: [],
        roleKey: context.sources.roles[0]!.key,
      },
    ],
    changeReason: '建立计划',
  })
  if (confirm) plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  const input = {
    requestId: randomUUID(),
    expectedPreparationRevision: 0,
    expectedPolicyRevision: null,
    expectedGoalRevision: 1,
    expectedPlanRevision: confirm ? 2 : 1,
    selectedStepKeys: ['brief'],
    executionKind: 'controlled' as const,
    executorEmployeeId: executor.id,
    reviewerEmployeeId: reviewer.id,
    workspaceId: workspace.id,
    knowledgeSourceIds: [],
    maxCostMicros: 1000000,
    maxRuns: 2,
    maxRework: 0,
    expiresAt: Date.now() + 3600000,
    changeReason: '保存暂停执行准备',
  }
  return { project, workspace, channel, executor, reviewer, input }
}
function count(table: string): number {
  return (store.getProjectDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number })
    .c
}
test('Given confirmed非代码计划 When 预览并保存 Then 冻结准确计划与paused policy，零任务/许可/运行副作用', () => {
  const f = fixture(),
    before = [
      'tasks',
      'pilot_runtime_grants',
      'pilot_commands',
      'agent_executions',
      'pilot_request_reservations',
    ].map(count)
  const preview = service.previewOwnerExecutionPreparation({ projectId: f.project.id }, f.input)
  expect(preview.stage).toBe('pending_task_links')
  expect(preview.planRevision).toBe(2)
  expect(preview.planVersion).toBe(1)
  const saved = service.saveOwnerExecutionPreparation(
    { projectId: f.project.id },
    f.input,
    preview.previewFingerprint,
  )
  expect(saved.stage).toBe('pending_task_links')
  expect(saved.revision).toBe(1)
  expect(policy.getPilotPolicy(f.project.id)?.state).toBe('paused')
  expect(
    [
      'tasks',
      'pilot_runtime_grants',
      'pilot_commands',
      'agent_executions',
      'pilot_request_reservations',
    ].map(count),
  ).toEqual(before)
  expect(() => grants.previewPilotGrantIssue(f.project.id, saved.policyRevision)).toThrow('Owner')
})
test('Given 未确认计划 When 预览 Then 不把内容/规划费用当执行许可', () => {
  const f = fixture(false)
  expect(() =>
    service.previewOwnerExecutionPreparation({ projectId: f.project.id }, f.input),
  ).toThrow('确认')
})
test('Given 相同request与preview When 重复保存 Then 同一准备历史，不重复policy修订', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    preview = service.previewOwnerExecutionPreparation(subject, f.input)
  const saved = service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint)
  expect(
    service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint),
  ).toEqual(saved)
  expect(service.listOwnerExecutionPreparationHistory(subject)).toHaveLength(1)
})
test('Given 准备前Goal更新 When 保存旧preview Then 拒绝，不能将旧scope绑新目标', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    preview = service.previewOwnerExecutionPreparation(subject, f.input)
  saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '修改目标' })
  expect(() =>
    service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint),
  ).toThrow('更新')
  expect(policy.getPilotPolicy(f.project.id)).toBeNull()
})

function saveFixture() {
  const f = fixture(),
    subject = { projectId: f.project.id },
    preview = service.previewOwnerExecutionPreparation(subject, f.input)
  const saved = service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint)
  return { ...f, subject, preview, saved }
}
test('Given prepared When 原confirm发行/通用草案去purpose Then 双入口拒绝并保留准备', () => {
  const f = saveFixture(),
    current = policy.getPilotPolicy(f.project.id)!
  const fakePreview = {
    projectId: f.project.id,
    policyRevision: current.revision,
    workspaceId: current.workspaceId,
    channelId: current.channelId,
    modelId: current.modelId,
    executorEmployeeId: current.executorEmployeeId!,
    reviewerEmployeeId: current.reviewerEmployeeId!,
    maxCostMicros: current.maxCostMicros,
    maxRuns: current.maxRuns,
    maxRework: current.maxRework,
    expiresAt: current.expiresAt,
    approvalFingerprint: grants.hashPilotGrantApproval(current),
  }
  expect(() => grants.confirmPilotGrantIssue(fakePreview, fakePreview.approvalFingerprint)).toThrow(
    'Owner',
  )
  expect(() =>
    policy.savePilotPolicyDraft(
      f.project.id,
      { ...current, executorEmployeeId: f.executor.id, reviewerEmployeeId: f.reviewer.id },
      current.revision,
    ),
  ).toThrow('Owner')
  expect(policy.getPilotPolicy(f.project.id)?.ownerExecutionPreparation?.id).toBe(f.saved.id)
})
test('Given prepared When JSON删除用途字段 Then 残余来源拒绝legacy发行，读取unapplied', () => {
  const f = saveFixture(),
    path = join(directory, 'project-pilot-policies.json'),
    index = JSON.parse(readFileSync(path, 'utf8')) as {
      policies: Array<{ projectId: string; ownerExecutionPreparation?: unknown }>
    }
  delete index.policies.find((item) => item.projectId === f.project.id)!.ownerExecutionPreparation
  writeFileSync(path, JSON.stringify(index))
  expect(service.getOwnerExecutionPreparation(f.subject).status).toBe('unapplied')
  expect(() => grants.previewPilotGrantIssue(f.project.id, f.saved.policyRevision)).toThrow('Owner')
})
test('Given prepared When 员工prompt或停用变化 Then current读取stale，旧preview保存拒绝', () => {
  const f = saveFixture()
  expect(service.getOwnerExecutionPreparation(f.subject).status).toBe('current')
  store.updateAgentEmployee(f.executor.id, { systemPrompt: '配置已变更' })
  expect(service.getOwnerExecutionPreparation(f.subject).status).toBe('stale')
  expect(() =>
    service.saveOwnerExecutionPreparation(f.subject, f.input, f.preview.previewFingerprint),
  ).toThrow('更新')
  store.updateAgentEmployee(f.reviewer.id, { enabled: false })
  expect(service.getOwnerExecutionPreparation(f.subject).status).toBe('stale')
})
test('Given source未关联项目 When 预览 Then 不借全局目录获取资料', () => {
  const f = fixture(),
    source = catalog.createSource({
      name: '其他项目',
      type: 'file',
      locator: join(directory, 'other.txt'),
    })
  expect(() =>
    service.previewOwnerExecutionPreparation(
      { projectId: f.project.id },
      { ...f.input, knowledgeSourceIds: [source.id] },
    ),
  ).toThrow('关联')
})
test('Given 选中正式source When 新增来源或旧源停用 Then 不扩大已冻结范围，撤权失效', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    source = catalog.createSource({
      name: '资料A',
      type: 'file',
      locator: join(directory, 'a.txt'),
    }),
    base = catalog.createKnowledgeBase({ name: '项目库A', sourceIds: [source.id] })
  catalog.bindProject({ projectId: f.project.id, knowledgeBaseId: base.id })
  const input = { ...f.input, knowledgeSourceIds: [source.id] },
    preview = service.previewOwnerExecutionPreparation(subject, input),
    saved = service.saveOwnerExecutionPreparation(subject, input, preview.previewFingerprint)
  expect(saved.source.knowledgeSources.map((item) => item.id)).toEqual([source.id])
  expect(saved.source.knowledgeSources[0]!.contentHash).toBeNull()
  const added = catalog.createSource({
      name: '资料B',
      type: 'file',
      locator: join(directory, 'b.txt'),
    }),
    addedBase = catalog.createKnowledgeBase({ name: '项目库B', sourceIds: [added.id] })
  catalog.bindProject({ projectId: f.project.id, knowledgeBaseId: addedBase.id })
  expect(
    service
      .getOwnerExecutionPreparation(subject)
      .preparation!.source.knowledgeSources.map((item) => item.id),
  ).toEqual([source.id])
  expect(service.getOwnerExecutionPreparation(subject).status).toBe('current')
  catalog.updateSource(source.id, { enabled: false })
  expect(service.getOwnerExecutionPreparation(subject).status).toBe('stale')
})
test('Given strict输入 When 欠闭包/未知步骤/同人/注入grant或task links Then 无持久变化', () => {
  const f = fixture(),
    subject = { projectId: f.project.id }
  for (const patch of [
    { selectedStepKeys: ['unknown'] },
    { executorEmployeeId: f.reviewer.id },
    { linkedTasks: ['fake'] },
    { actor: 'remote-admin' },
    { state: 'active' },
    { maxCostMicros: 0 },
    { expiresAt: 1 },
    { selectedStepKeys: ['brief', 'brief'] },
    {
      executionKind: 'controlled',
      developmentScope: { workspaceId: f.workspace.id, targetPaths: ['a'], allowedPaths: ['.'] },
    },
  ])
    expect(() =>
      service.previewOwnerExecutionPreparation(subject, { ...f.input, ...patch }),
    ).toThrow()
  expect(policy.getPilotPolicy(f.project.id)).toBeNull()
  expect(service.listOwnerExecutionPreparationHistory(subject)).toHaveLength(0)
})
test('Given 非代码托管工作区 When 切研发模式 Then 不偷取消Git/人员模式门禁', () => {
  const f = fixture()
  expect(() =>
    service.previewOwnerExecutionPreparation(
      { projectId: f.project.id },
      { ...f.input, executionKind: 'development' },
    ),
  ).toThrow('模式')
})
test('Given DB insert被ABORT When 保存 Then 无policy半写/准备记录', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    preview = service.previewOwnerExecutionPreparation(subject, f.input),
    db = store.getProjectDb()
  db.exec(
    "CREATE TRIGGER owner_prepare_fail BEFORE INSERT ON project_owner_execution_preparations BEGIN SELECT RAISE(ABORT,'injected owner failure'); END",
  )
  try {
    expect(() =>
      service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint),
    ).toThrow('injected owner failure')
    expect(policy.getPilotPolicy(f.project.id)).toBeNull()
    expect(service.listOwnerExecutionPreparationHistory(subject)).toHaveLength(0)
  } finally {
    db.exec('DROP TRIGGER owner_prepare_fail')
  }
})
test('Given 同requestID变输入 When 保存 Then 拒绝，不追加history或扩大预算', () => {
  const f = saveFixture()
  expect(() =>
    service.saveOwnerExecutionPreparation(
      f.subject,
      { ...f.input, maxCostMicros: 2000000 },
      f.preview.previewFingerprint,
    ),
  ).toThrow('不同输入')
  expect(service.listOwnerExecutionPreparationHistory(f.subject)).toHaveLength(1)
})
test('Given prepared证据损坏 When 读/发行/删除 Then 保留证据并fail closed', () => {
  const f = saveFixture()
  store
    .getProjectDb()
    .prepare("UPDATE project_owner_execution_preparations SET integrity_hash='' WHERE id=?")
    .run(f.saved.id)
  expect(() => service.getOwnerExecutionPreparation(f.subject)).toThrow('历史无效')
  expect(() => grants.previewPilotGrantIssue(f.project.id, f.saved.policyRevision)).toThrow('Owner')
  expect(() => store.deleteProject(f.project.id)).toThrow('证据')
})
test('Given prepared When DB重开 Then 暂停准备与policy原样，零运行账本', async () => {
  const f = saveFixture()
  store.closeProjectDb()
  await store.initProjectDb()
  expect(service.getOwnerExecutionPreparation(f.subject).status).toBe('current')
  expect(service.listOwnerExecutionPreparationHistory(f.subject)[0]).toEqual(f.saved)
  expect(count('agent_executions')).toBe(0)
  expect(count('pilot_runtime_grants')).toBe(0)
})
test('Given 既有active/unknown命令占额 When 准备 Then 不新开范围或释放旧预算', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    db = store.getProjectDb(),
    id = randomUUID()
  db.prepare(
    `INSERT INTO pilot_runtime_grants (id,project_id,policy_revision,state,workspace_id,channel_id,model_id,executor_employee_id,reviewer_employee_id,max_cost_micros,max_runs,max_rework,expires_at,approval_fingerprint,created_at) VALUES (?,?,1,'active',?,?,?,?,?,1000,1,0,?,'old-proof',?)`,
  ).run(
    id,
    f.project.id,
    f.workspace.id,
    f.channel.id,
    'model',
    f.executor.id,
    f.reviewer.id,
    f.input.expiresAt,
    Date.now(),
  )
  try {
    expect(() => service.previewOwnerExecutionPreparation(subject, f.input)).toThrow('活动授权')
    db.prepare("UPDATE pilot_runtime_grants SET state='paused' WHERE id=?").run(id)
    db.prepare(
      `INSERT INTO pilot_commands (id,project_id,grant_id,idempotency_key,source_task_id,source_version,source_hash,employee_id,role,rework_ordinal,reserved_cost_micros,state,created_at,updated_at) VALUES (?,?,?,'old-unknown','old-source',1,'old',?,'executor',0,1000,'needs_reconcile',?,?)`,
    ).run(id, f.project.id, id, f.executor.id, Date.now(), Date.now())
    expect(() => service.previewOwnerExecutionPreparation(subject, f.input)).toThrow('未决占额')
    expect(
      db.prepare('SELECT state,reserved_cost_micros FROM pilot_commands WHERE id=?').get(id),
    ).toEqual({ state: 'needs_reconcile', reserved_cost_micros: 1000 })
    expect(policy.getPilotPolicy(f.project.id)).toBeNull()
  } finally {
    db.prepare('DELETE FROM pilot_commands WHERE id=?').run(id)
    db.prepare('DELETE FROM pilot_runtime_grants WHERE id=?').run(id)
  }
})
test('Given 准备只选后续step When 依赖未选 Then 拒绝，而全闭包仍pending', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    context = plans.getProjectOwnerPlanningContext(f.project.id),
    role = context.sources.roles[0]!.key
  plans.saveProjectOwnerPlanDraft(f.project.id, 1, 2, {
    expectedContextFingerprint: context.fingerprint,
    summary: '依赖方案',
    assumptions: [],
    risks: [],
    steps: [
      {
        key: 'a',
        title: '前置',
        outcome: '前置产物',
        acceptanceCriteria: ['合格'],
        dependencies: [],
        roleKey: role,
      },
      {
        key: 'b',
        title: '后续',
        outcome: '后续产物',
        acceptanceCriteria: ['合格'],
        dependencies: ['a'],
        roleKey: role,
      },
    ],
    changeReason: '加入依赖',
  })
  plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 3)
  expect(() =>
    service.previewOwnerExecutionPreparation(subject, {
      ...f.input,
      expectedPlanRevision: 4,
      selectedStepKeys: ['b'],
    }),
  ).toThrow('闭包')
  expect(
    service.previewOwnerExecutionPreparation(subject, {
      ...f.input,
      expectedPlanRevision: 4,
      selectedStepKeys: ['b', 'a'],
    }).selectedStepKeys,
  ).toEqual(['a', 'b'])
})
test('Given 同planVersion再次确认revision变化 When 使用旧preview Then 精确revision拒绝', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    preview = service.previewOwnerExecutionPreparation(subject, f.input)
  // 人工确认在服务上是幂等；真实新计划确认必须新内容版本，不伪造第三次confirmed历史。
  expect(preview.planRevision).toBe(2)
  expect(preview.planVersion).toBe(1)
  expect(() =>
    service.previewOwnerExecutionPreparation(subject, { ...f.input, expectedPlanRevision: 1 }),
  ).toThrow('更新')
})
test('Given 未决请求失去command归属 When 保存新边界 Then 不把孤立占额当零', () => {
  const f = fixture(),
    db = store.getProjectDb(),
    id = randomUUID()
  db.prepare(
    `INSERT INTO pilot_request_reservations (request_id,command_id,execution_id,session_id,request_evidence_id,price_evidence_id,reserved_cost_micros,state,created_at) VALUES (?,?,?,?,?,?,500,'needs_reconcile',?)`,
  ).run(id, 'missing-command', 'missing-execution', 'missing-session', 'hash', 'price', Date.now())
  try {
    expect(() =>
      service.previewOwnerExecutionPreparation({ projectId: f.project.id }, f.input),
    ).toThrow('未决占额')
    expect(
      db
        .prepare(
          'SELECT reserved_cost_micros,state FROM pilot_request_reservations WHERE request_id=?',
        )
        .get(id),
    ).toEqual({ reserved_cost_micros: 500, state: 'needs_reconcile' })
  } finally {
    db.prepare('DELETE FROM pilot_request_reservations WHERE request_id=?').run(id)
  }
})
test('Given 同项目真实单任务准备 When 任务改派或删除 Then source失效、证据保留', () => {
  const f = fixture(),
    task = store.createTask(f.project.id, { title: '真实目标业务任务', description: '' }),
    subject = { projectId: f.project.id, taskId: task.id }
  saveProjectOwnerGoalDraft(f.project.id, 0, { objective: '单任务目标' }, task.id)
  const context = plans.getProjectOwnerPlanningContext(f.project.id, task.id)
  plans.saveProjectOwnerPlanDraft(
    f.project.id,
    1,
    0,
    {
      expectedContextFingerprint: context.fingerprint,
      summary: '单任务计划',
      assumptions: [],
      risks: [],
      steps: [
        {
          key: 'brief',
          title: '分析',
          outcome: '交付',
          acceptanceCriteria: ['范围明确'],
          dependencies: [],
          roleKey: context.sources.roles[0]!.key,
        },
      ],
      changeReason: '单任务准备',
    },
    task.id,
  )
  plans.confirmProjectOwnerPlanDraft(f.project.id, 1, 1, task.id)
  const preview = service.previewOwnerExecutionPreparation(subject, f.input),
    saved = service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint)
  expect(saved.taskId).toBe(task.id)
  expect(saved.source.targetTaskHash).toMatch(/^[a-f0-9]{64}$/)
  expect(() => store.deleteTask(task.id)).toThrow('证据')
  store.updateTask(task.id, { priority: 'high' })
  expect(service.getOwnerExecutionPreparation(subject).status).toBe('stale')
})
test('Given 外层未提交事务 When 两个保存入口 Then 直接拒绝，DB与JSON无半写', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    preview = service.previewOwnerExecutionPreparation(subject, f.input),
    db = store.getProjectDb()
  db.transaction(() => {
    expect(() =>
      service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint),
    ).toThrow('外层事务')
    expect(() =>
      policy.saveOwnerPreparationPolicy(f.project.id, null, () => {
        throw new Error('不应进入callback')
      }),
    ).toThrow('外层事务')
  })()
  expect(policy.getPilotPolicy(f.project.id)).toBeNull()
  expect(service.listOwnerExecutionPreparationHistory(subject)).toHaveLength(0)
})

test('Given Skill脚本与规则资源 When 只改SKILL.md之外资源 Then current变stale且旧preview拒绝', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    root = join(getWorkspaceSkillsDir(f.workspace.slug), 'probe-skill')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'references'))
  writeFileSync(join(root, 'SKILL.md'), '# 技能\n使用scripts/action.py与references/rules.md')
  writeFileSync(join(root, 'scripts/action.py'), 'v1')
  writeFileSync(join(root, 'references/rules.md'), '规则1')
  const preview = service.previewOwnerExecutionPreparation(subject, f.input)
  service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint)
  writeFileSync(join(root, 'scripts/action.py'), 'v2')
  expect(service.getOwnerExecutionPreparation(subject).status).toBe('stale')
  expect(() =>
    service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint),
  ).toThrow('更新')
})
test('Given 明确无或已有Owner绑定 When 保存并更换绑定 Then provenance准确，carrier不代替执行许可', () => {
  const f = fixture(),
    subject = { projectId: f.project.id }
  expect(
    service.previewOwnerExecutionPreparation(subject, f.input).ownerBindingProvenance.state,
  ).toBe('none')
  const binding = bindings.saveOwnerRuntimeBinding(f.project.id, 0, {
    ownerName: '业务Owner',
    carrierId: f.executor.id,
    workspaceId: f.workspace.id,
    changeReason: '配置既有载体',
  })
  const preview = service.previewOwnerExecutionPreparation(subject, f.input)
  expect(preview.ownerBindingProvenance).toMatchObject({
    state: 'bound',
    bindingRevision: binding.revision,
    carrierId: f.executor.id,
  })
  service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint)
  bindings.saveOwnerRuntimeBinding(f.project.id, 1, {
    ownerName: '业务Owner',
    carrierId: f.reviewer.id,
    workspaceId: f.workspace.id,
    changeReason: '换载体',
  })
  expect(service.getOwnerExecutionPreparation(subject).status).toBe('stale')
  expect(preview.executor.id).toBe(f.executor.id)
})
test('Given Skill symlink指向包外 When 预览 Then 不读取逃逸资源，不落准备', () => {
  const f = fixture(),
    root = join(getWorkspaceSkillsDir(f.workspace.slug), 'escape-skill')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), '# 限定包')
  const outside = join(directory, 'private-outside.txt')
  writeFileSync(outside, 'not-readable-as-skill')
  symlinkSync(outside, join(root, 'references-link'))
  expect(() =>
    service.previewOwnerExecutionPreparation({ projectId: f.project.id }, f.input),
  ).toThrow('不能安全冻结')
  expect(policy.getPilotPolicy(f.project.id)).toBeNull()
})
test('Given Skill资源大于冻结上限 When 预览 Then 明确拒绝，不伪造完整能力摘要', () => {
  const f = fixture(),
    root = join(getWorkspaceSkillsDir(f.workspace.slug), 'large-skill')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), '# 大包')
  writeFileSync(join(root, 'oversize.bin'), Buffer.alloc(4 * 1024 * 1024 + 1))
  expect(() =>
    service.previewOwnerExecutionPreparation({ projectId: f.project.id }, f.input),
  ).toThrow('大小超限')
  expect(policy.getPilotPolicy(f.project.id)).toBeNull()
})
test('Given 原始BEGIN/SAVEPOINT未提交 When 两个save Then 真实事务状态拒绝，回滚不丢准备证据', () => {
  const f = fixture(),
    subject = { projectId: f.project.id },
    preview = service.previewOwnerExecutionPreparation(subject, f.input),
    db = store.getProjectDb()
  for (const begin of ['BEGIN IMMEDIATE', 'SAVEPOINT external_preparation']) {
    db.exec(begin)
    try {
      expect(db.isTransactionActive()).toBe(true)
      expect(() =>
        service.saveOwnerExecutionPreparation(subject, f.input, preview.previewFingerprint),
      ).toThrow('外层事务')
      expect(() =>
        policy.saveOwnerPreparationPolicy(f.project.id, null, () => {
          throw new Error('不应写JSON')
        }),
      ).toThrow('外层事务')
    } finally {
      db.exec('ROLLBACK')
    }
    expect(db.isTransactionActive()).toBe(false)
    expect(policy.getPilotPolicy(f.project.id)).toBeNull()
    expect(service.listOwnerExecutionPreparationHistory(subject)).toHaveLength(0)
  }
})
test('Given 常见无扩展名SSH私钥basename When Skill冻结 Then 不读取秘密资源', () => {
  const f = fixture(),
    root = join(getWorkspaceSkillsDir(f.workspace.slug), 'private-skill')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), '# 配置')
  writeFileSync(join(root, 'id_rsa'), 'PRIVATE KEY FIXTURE')
  expect(() =>
    service.previewOwnerExecutionPreparation({ projectId: f.project.id }, f.input),
  ).toThrow('不能安全冻结')
  expect(policy.getPilotPolicy(f.project.id)).toBeNull()
})
