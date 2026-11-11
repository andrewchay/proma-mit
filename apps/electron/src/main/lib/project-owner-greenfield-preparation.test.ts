import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-greenfield-preparation-'))
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
const prep = await import('./project-owner-execution-preparation')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

/** 建一个带首个提交的 git 仓库工作区：研发交付基线来自 HEAD。 */
function gitRepository(withCommit: boolean): string {
  const repo = mkdtempSync(join(tmpdir(), 'owner-greenfield-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# 空项目\n')
  if (withCommit) {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: repo })
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo })
  }
  return repo
}

/** 绿地准备夹具：目标是本次新建 index.html，验证只用内置断言。 */
function fixture(rootPath: string, deliveryKind?: 'text' | 'development' | 'mixed' | 'mixed-roles') {
  const project = store.createProject({ title: '绿地2048', description: '' })
  const workspace = createAgentWorkspace(`owner-greenfield-${randomUUID()}`, rootPath)
  bindWorkspaceToProject(project.id, workspace.id)
  const modelId = 'glm-5.3-flash'
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研发', description: '', executionProfile: 'development', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('研发执行者'), reviewer = employee('研发评审')
  const writer = deliveryKind === 'mixed-roles' ? employees.createAgentEmployee({ name: '文字执行者', role: '分析', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] }) : undefined
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '从零做一个可玩的 2048 单页' })
  const context = plans.getProjectOwnerPlanningContext(project.id)
  const steps = deliveryKind === 'mixed' || deliveryKind === 'mixed-roles'
    ? [{ key: 'spec', title: '需求说明', outcome: '文本说明', acceptanceCriteria: ['规则明确'], dependencies: [], roleKey: context.sources.roles[0]!.key, deliveryKind: 'text' as const }, { key: 'build', title: '实现页面', outcome: '单页文件', acceptanceCriteria: ['可玩'], dependencies: ['spec'], roleKey: deliveryKind === 'mixed-roles' ? context.sources.roles[1]!.key : context.sources.roles[0]!.key, deliveryKind: 'development' as const }]
    : [{ key: 'build', title: '实现页面', outcome: '单页文件', acceptanceCriteria: ['可玩'], dependencies: [], roleKey: context.sources.roles[0]!.key, ...(deliveryKind ? { deliveryKind } : {}) }]
  const roleAssignments = writer ? [{ roleKey: steps[0]!.roleKey, employeeId: writer.id }, { roleKey: steps[1]!.roleKey, employeeId: executor.id }].sort((a, b) => a.roleKey.localeCompare(b.roleKey)) : [{ roleKey: steps[0]!.roleKey, employeeId: executor.id }]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '实现单页', assumptions: [], risks: [], steps, changeReason: '建立计划' })
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1)
  return {
    project,
    subject: { projectId: project.id },
    input: {
      requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null,
      expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step => step.key), executionKind: 'development' as const,
      ...(deliveryKind === 'mixed' || deliveryKind === 'mixed-roles' ? { qualityManagementVersion: 1 as const } : {}),
      employeeRuntimeVersion: 2 as const, executorEmployeeId: roleAssignments[0]!.employeeId, reviewerEmployeeId: reviewer.id,
      roleAssignments, workspaceId: workspace.id,
      knowledgeSourceIds: [], maxCostMicros: 500000, maxRuns: 4, maxRework: 1, expiresAt: Date.now() + 3_600_000,
      changeReason: '绿地研发准备',
      developmentScope: { workspaceId: workspace.id, targetPaths: ['index.html'], allowedPaths: ['index.html'], verificationCommands: ['browser:html.loads+dom.board+behavior.merge'] },
    },
    writer, executor, reviewer,
  }
}

test('Given 绿地研发范围 When 预览并保存执行准备 Then 不再被文本交付或代码候选挡住', () => {
  const repo = gitRepository(true)
  try {
    const f = fixture(repo)
    const preview = prep.previewOwnerExecutionPreparation(f.subject, f.input)
    // 绿地范围必须原样进入准备来源，而不是被降级为文本交付。
    expect(preview.previewFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const saved = prep.saveOwnerExecutionPreparation(f.subject, f.input, preview.previewFingerprint)
    expect(saved.input.executionKind).toBe('development')
    expect(saved.input.developmentScope?.targetPaths).toEqual(['index.html'])
    expect(saved.input.developmentScope?.verificationCommands).toEqual(['browser:html.loads+dom.board+behavior.merge'])
    // 绿地执行不能退化成完整文本交付，否则 Write/Edit 会被移出工具集。
    expect(saved.input.textDeliveryVersion).toBeUndefined()
  } finally { rmSync(repo, { recursive: true, force: true }) }
})


test('Given 仓库没有首个提交 When 预览执行准备 Then 明确拒绝而不是留下半启动状态', () => {
  const repo = gitRepository(false)
  try {
    const f = fixture(repo)
    expect(() => prep.previewOwnerExecutionPreparation(f.subject, f.input)).toThrow()
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Given 步骤明确交付文本 When 研发批次试图登记该步骤 Then 在准备阶段拒绝不匹配', () => {
  const repo = gitRepository(true)
  try {
    const f = fixture(repo, 'text')
    expect(() => prep.previewOwnerExecutionPreparation(f.subject, f.input)).toThrow('无法逐步匹配')
    expect(store.getProjectDb().prepare('SELECT COUNT(*) AS n FROM project_owner_execution_preparations WHERE project_id=?').get(f.project.id)).toEqual({ n: 0 })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Given文本需求和代码实现组成的计划 When准备并冻结任务 Then逐步骤保留成果类型与受控权限', async () => {
  const repo = gitRepository(true)
  try {
    const f = fixture(repo, 'mixed')
    const materialization = await import('./project-owner-task-materialization')
    const revalidation = await import('./project-owner-execution-revalidation')
    const grants = await import('./project-owner-execution-grant-issue')
    const commands = await import('./project-owner-execution-command')
    const policy = await import('./project-pilot-policy')
    const preparation = prep.saveOwnerExecutionPreparation(f.subject, f.input, prep.previewOwnerExecutionPreparation(f.subject, f.input).previewFingerprint)
    expect(preparation.source.employeeInvocations).toHaveLength(2)
    expect(preparation.source.employeeInvocations?.every(item => item.executionProfile === 'controlled' && item.permissionMode === 'safe')).toBe(true)
    const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
    const batch = materialization.materializeOwnerTasks(f.subject, materialInput, materialization.previewOwnerTaskMaterialization(f.subject, materialInput).previewFingerprint)
    const text = batch.links.find(link => link.stepKey === 'spec')!, code = batch.links.find(link => link.stepKey === 'build')!
    expect(text.projection.deliveryKind).toBe('text')
    expect(text.projection.developmentScope).toBeUndefined()
    expect(code.projection.deliveryKind).toBe('development')
    expect(code.projection.developmentScope?.allowedPaths).toEqual(['index.html'])
    const validationInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '核对任务' }
    const validation = revalidation.saveOwnerExecutionRevalidation(f.subject, validationInput, revalidation.previewOwnerExecutionRevalidation(f.subject, validationInput).previewFingerprint)
    expect(validation.source.tasks.find(task => task.taskId === text.taskId)?.developmentScope).toBeUndefined()
    expect(validation.source.tasks.find(task => task.taskId === code.taskId)?.developmentScope?.allowedPaths).toEqual(['index.html'])
    const issueInput = { requestId: randomUUID(), expectedRevalidationRevision: validation.revision, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, dispatchMode: 'manual' as const }
    const issuePreview = grants.previewOwnerExecutionGrantIssue(f.subject, issueInput)
    const grant = grants.confirmOwnerExecutionGrantIssue(f.subject, { input: issueInput, preview: issuePreview, confirmedFingerprint: issuePreview.approvalFingerprint })
    const input = { grantId: grant.grantId, taskId: text.taskId, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: validation.revision }
    const preview = commands.previewOwnerExecutionCommandAck(f.subject, input)
    const commandId = randomUUID(), executionId = randomUUID()
    commands.reserveAndQueueOwnerCommand(f.subject, { ...input, commandId, idempotencyKey: randomUUID() }, { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }, { executionId })
    expect(store.getAgentExecution(executionId)!.prompt).toContain('完整')
    expect(store.getAgentExecution(executionId)!.prompt).not.toContain('仅可修改已授权路径')
    expect(() => commands.previewOwnerExecutionCommandAck(f.subject, { ...input, taskId: code.taskId })).toThrow()
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Given文本岗位与研发岗位使用不同员工 When冻结混合计划 Then按岗位验证并保存各自调用方式', () => {
  const repo = gitRepository(true)
  try {
    const f = fixture(repo, 'mixed-roles')
    const preview = prep.previewOwnerExecutionPreparation(f.subject, f.input)
    const saved = prep.saveOwnerExecutionPreparation(f.subject, f.input, preview.previewFingerprint)
    expect(saved.source.roleAssignments?.map(item => item.employee.id).sort()).toEqual([f.writer!.id, f.executor.id].sort())
    expect(saved.source.employeeInvocations?.map(item => item.employeeId)).toEqual([f.reviewer.id])
    expect(store.getAgentEmployee(f.writer!.id)?.executionProfile).toBe('controlled')
    expect(store.getAgentEmployee(f.executor.id)?.executionProfile).toBe('development')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('Given 研发任务已获授权 When 员工排队 Then 提示明确允许的文件路径和交付方式', async () => {
  const repo = gitRepository(true)
  try {
    const f = fixture(repo, 'development')
    const materialization = await import('./project-owner-task-materialization')
    const revalidation = await import('./project-owner-execution-revalidation')
    const grants = await import('./project-owner-execution-grant-issue')
    const commands = await import('./project-owner-execution-command')
    const policy = await import('./project-pilot-policy')
    const preparation = prep.saveOwnerExecutionPreparation(f.subject, f.input, prep.previewOwnerExecutionPreparation(f.subject, f.input).previewFingerprint)
    const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
    const batch = materialization.materializeOwnerTasks(f.subject, materialInput, materialization.previewOwnerTaskMaterialization(f.subject, materialInput).previewFingerprint)
    const validationInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '核对任务' }
    const validation = revalidation.saveOwnerExecutionRevalidation(f.subject, validationInput, revalidation.previewOwnerExecutionRevalidation(f.subject, validationInput).previewFingerprint)
    expect(batch.links[0]!.projection.deliveryKind).toBe('development')
    expect(validation.source.tasks[0]!.deliveryKind).toBe('development')
    const issueInput = { requestId: randomUUID(), expectedRevalidationRevision: validation.revision, expectedPolicyRevision: policy.getPilotPolicy(f.project.id)!.revision, dispatchMode: 'manual' as const }
    const issuePreview = grants.previewOwnerExecutionGrantIssue(f.subject, issueInput)
    const grant = grants.confirmOwnerExecutionGrantIssue(f.subject, { input: issueInput, preview: issuePreview, confirmedFingerprint: issuePreview.approvalFingerprint })
    const input = { grantId: grant.grantId, taskId: batch.links[0]!.taskId, role: 'executor' as const, reworkOrdinal: 0, expectedRevalidationRevision: validation.revision }
    const preview = commands.previewOwnerExecutionCommandAck(f.subject, input)
    const commandId = randomUUID(), executionId = randomUUID()
    commands.reserveAndQueueOwnerCommand(f.subject, { ...input, commandId, idempotencyKey: randomUUID() }, { input, preview, confirmedFingerprint: preview.ackFingerprint, acknowledgeModelCosts: true }, { executionId })
    const prompt = store.getAgentExecution(executionId)!.prompt
    expect(prompt).toContain('仅可修改已授权路径 ["index.html"]')
    expect(prompt).toContain('本步骤需要产生可核验的文件变更')
    expect(prompt).not.toContain('启动其他员工或写回/发布成果')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
