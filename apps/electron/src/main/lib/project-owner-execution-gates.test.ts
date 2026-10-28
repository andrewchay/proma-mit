import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-execution-gates-')), previous = process.env.PROMA_TEST_CONFIG_DIR
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
const materialization = await import('./project-owner-task-materialization')
const revalidation = await import('./project-owner-execution-revalidation')
const grants = await import('./project-pilot-grant-issue')
const policy = await import('./project-pilot-policy')
const gates = await import('./project-owner-execution-gates')
const { executeBashToolOnPlatform } = await import('./agent-runtime/tool-impls/bash-tool')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(single = false, textDelivery = false) {
  const project = store.createProject({ title: 'Owner门禁fixture', description: '' })
  const target = single ? store.createTask(project.id, { title: '单任务', description: '' }) : null
  const workspace = createAgentWorkspace(`owner-gates-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const modelId = textDelivery ? 'glm-5.3-flash' : 'model'
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: modelId, name: modelId, enabled: true }] })
  const employee = (name: string) => employees.createAgentEmployee({ name, role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId, workspaceIds: [workspace.id] })
  const executor = employee('执行者'), reviewer = employee('技术评审')
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案' }, target?.id)
  const context = plans.getProjectOwnerPlanningContext(project.id, target?.id)
  const steps = [{ key: 'brief', title: '研究', outcome: '材料', acceptanceCriteria: ['范围明确'], dependencies: [], roleKey: context.sources.roles[0]!.key }, ...(single ? [] : [{ key: 'report', title: '汇总', outcome: '方案', acceptanceCriteria: ['有依据'], dependencies: ['brief'], roleKey: context.sources.roles[0]!.key }])]
  plans.saveProjectOwnerPlanDraft(project.id, 1, 0, { expectedContextFingerprint: context.fingerprint, summary: '形成方案', assumptions: [], risks: [], steps, changeReason: '建立计划' }, target?.id)
  plans.confirmProjectOwnerPlanDraft(project.id, 1, 1, target?.id)
  const subject = { projectId: project.id, ...(target ? { taskId: target.id } : {}) }
  const preparationInput = { requestId: randomUUID(), expectedPreparationRevision: 0, expectedPolicyRevision: null, expectedGoalRevision: 1, expectedPlanRevision: 2, selectedStepKeys: steps.map(step => step.key), executionKind: 'controlled' as const, ...(textDelivery ? { employeeRuntimeVersion: 2 as const, textDeliveryVersion: 1 as const, qualityManagementVersion: 1 as const } : {}), executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id, roleAssignments: [...new Set(steps.map(step => step.roleKey))].map(roleKey => ({ roleKey, employeeId: executor.id })), workspaceId: workspace.id, knowledgeSourceIds: [], maxCostMicros: 1000000, maxRuns: 2, maxRework: 0, expiresAt: Date.now() + 3600000, changeReason: '暂停准备' }
  const pv = prep.previewOwnerExecutionPreparation(subject, preparationInput), preparation = prep.saveOwnerExecutionPreparation(subject, preparationInput, pv.previewFingerprint)
  const materialInput = { requestId: randomUUID(), expectedMaterializationRevision: 0, expectedPreparationId: preparation.id, expectedPreparationRevision: preparation.revision, expectedPreparationHash: preparation.integrityHash, expectedPolicyRevision: preparation.policyRevision }
  const mpv = materialization.previewOwnerTaskMaterialization(subject, materialInput), batch = materialization.materializeOwnerTasks(subject, materialInput, mpv.previewFingerprint)
  const revalInput = { requestId: randomUUID(), expectedRevalidationRevision: 0, expectedMaterializationId: batch.id, expectedMaterializationRevision: batch.revision, expectedMaterializationHash: batch.integrityHash, expectedPolicyRevision: batch.input.expectedPolicyRevision, changeReason: '按真实任务重冻结' }
  const rpv = revalidation.previewOwnerExecutionRevalidation(subject, revalInput), record = revalidation.saveOwnerExecutionRevalidation(subject, revalInput, rpv.previewFingerprint)
  return { project, target, subject, batch, record, executor }
}
function syntheticRunningExecution(f: ReturnType<typeof fixture>): string {
  const task = f.target ?? store.listTasks(f.project.id)[0]!
  const sessionId = randomUUID(), executionId = randomUUID()
  // 合成"合法owner命令execution"的豁免形态：直接写running账本（未来发行片经claim创建）。
  store.getProjectDb().prepare("INSERT INTO agent_executions (id, project_id, entity_type, entity_id, agent_id, session_id, status, prompt, started_at) VALUES (?, ?, 'task', ?, ?, ?, 'running', '合成合法执行账本', ?)").run(executionId, f.project.id, task.id, `agent-${f.executor.id}`, sessionId, Date.now())
  return sessionId
}
test('Given 无Owner证据会话 When 工具谓词 Then 与现状一致放行不抛', () => {
  expect(() => gates.assertToolAllowedForSessionPurpose(randomUUID(), 'Bash', {})).not.toThrow()
  expect(gates.resolveOwnerExecutionGateSession(randomUUID()).kind).toBe('unrestricted')
})
test('Given Owner证据但无gate准入 When 任意工具含知识工具 Then 全拒fail-closed', () => {
  const f = fixture()
  const sessionId = syntheticRunningExecution(f)
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'SearchKnowledge', {})).toThrow('门禁')
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'Bash', {})).toThrow('Owner')
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  expect(() => gates.admitOwnerExecutionGateSession(executionId, sessionId)).not.toThrow()
  // 准入成功后仍只放行知识工具
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'Bash', {})).toThrow('Owner')
})
test('Given gate准入+冻结空资料集合 When 知识工具 Then 交集为空拒绝，其余工具拒', () => {
  const f = fixture()
  const sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'SearchKnowledge', {})).toThrow('交集')
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'ReadMcpResourceTool', {})).toThrow('Owner')
})
test('Given 已准入的 Owner 业务会话 When 直接调用 Bash 工具 Then 工具入口拒绝且不创建文件', async () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  const work = mkdtempSync(join(tmpdir(), 'owner-bash-work-'))
  try {
    const marker = join(work, 'marker')
    const ordinary = await executeBashToolOnPlatform({ command: `touch '${marker}'` }, { cwd: work, sessionId: randomUUID() }, 'darwin')
    expect(ordinary.isError).toBeFalsy()
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    const result = await executeBashToolOnPlatform({ command: `touch '${marker}'` }, { cwd: work, sessionId, ownerWorkspaceWrite: true }, 'darwin')
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Owner')
    expect(existsSync(marker)).toBe(false)
  } finally { rmSync(work, { recursive: true, force: true }) }
})
test('Given 完整文本交付 Owner执行 When 构建工具白名单 Then 不暴露工作区写入工具', () => {
  const f = fixture(false, true), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  expect([...gates.getOwnerExecutionToolNames(sessionId)!].sort()).toEqual(['AskUserQuestion', 'ReadKnowledgeSource', 'SearchKnowledge'])
})
test('Given合法Owner gate When文件写入 Then仅工作区内Write/Edit可进入逐次审批且审批前不执行', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  expect(gates.isOwnerWorkspaceFileActionCandidate(sessionId, 'Write', { file_path: 'denied.txt' })).toBe(true)
  expect(gates.isOwnerWorkspaceFileActionCandidate(sessionId, 'Edit', { file_path: 'edit.md' })).toBe(true)
  expect(gates.isOwnerWorkspaceFileActionCandidate(sessionId, 'Write', { file_path: '../outside.txt' })).toBe(false)
  expect(gates.isOwnerWorkspaceFileActionCandidate(sessionId, 'Bash', { command: 'touch denied.txt' })).toBe(false)
  // 无研发范围时不自动授予文件写入权限。
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'Write', { file_path: 'new-file.txt', content: 'test' })).toThrow('人工审批')
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'Bash', { command: 'touch denied.txt' })).toThrow('仅允许工作区内Write/Edit')
})
test('Given 空集合白名单 When ReadKnowledgeSource任意documentId Then 拒且无审计行', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'ReadKnowledgeSource', { documentId: 'any-document' })).toThrow('白名单')
  expect((store.getProjectDb().prepare('SELECT COUNT(*) AS c FROM project_owner_execution_knowledge_reads WHERE session_id=?').get(sessionId) as { c: number }).c).toBe(0)
})
test('Given unknown purpose When 逐请求核验 Then 拒（白名单式fail-closed）', () => {
  expect(() => gates.assertOwnerExecutionRequestGate({ commandPurpose: 'evil-purpose', sessionId: randomUUID(), runtime: 'ai-sdk', modelId: 'model', permissionMode: 'safe', cwd: '/tmp', baseUrl: '', requestUrl: '' })).toThrow('未知Pilot命令用途')
})
test('Given admit重复 When 同execution Then 返回同gate；换execution拒绝', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  const first = gates.admitOwnerExecutionGateSession(executionId, sessionId)
  expect(gates.admitOwnerExecutionGateSession(executionId, sessionId)).toEqual(first)
  expect(() => gates.admitOwnerExecutionGateSession(randomUUID(), sessionId)).toThrow('其他执行身份')
})
test('Given 快照漂移 When 知识工具 Then 全拒且要求重新准入', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  // 准入后索引内容被外部改变（TEMP直改快照模拟reindex漂移）。
  store.getProjectDb().prepare("UPDATE project_owner_execution_gate_sessions SET content_snapshot_hash=? WHERE session_id=?").run('stale-snapshot', sessionId)
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'SearchKnowledge', {})).toThrow('漂移')
})
test('Given v2 drift When 工具谓词 Then restricted不降级', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  // 破坏v2上游：删除材料化header（保留links/marker）→v2 current反查失败。
  store.getProjectDb().prepare('DELETE FROM project_owner_task_materializations WHERE id=?').run(f.batch.id)
  const context = gates.resolveOwnerExecutionGateSession(sessionId)
  expect(context.kind).toBe('restricted')
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'SearchKnowledge', {})).toThrow()
})
test('Given 外层事务 When admit Then 拒绝且该会话零写入', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const db = store.getProjectDb()
  db.exec('BEGIN IMMEDIATE')
  try { expect(() => gates.admitOwnerExecutionGateSession((db.prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id, sessionId)).toThrow('外层事务') } finally { db.exec('ROLLBACK') }
  expect((db.prepare('SELECT COUNT(*) AS c FROM project_owner_execution_gate_sessions WHERE session_id=?').get(sessionId) as { c: number }).c).toBe(0)
})
test('Given purpose迁移 When 存量默认 Then controlled_task且现有reserve行为不变', () => {
  const f = fixture()
  const columns = store.getProjectDb().prepare('PRAGMA table_info(pilot_commands)').all() as Array<{ name: string; dflt_value: string | null }>
  const purpose = columns.find(column => column.name === 'purpose')
  expect(purpose?.dflt_value).toBe("'controlled_task'")
  expect(() => grants.previewPilotGrantIssue(f.project.id, policy.getPilotPolicy(f.project.id)!.revision)).toThrow('Owner')
})
test('Given 畸形仅v2 policy When pilotGrantMatchesPolicy Then false（R1防御）', () => {
  const f = fixture()
  const current = policy.getPilotPolicy(f.project.id)!
  const malformed = { ...current, ownerExecutionPreparation: undefined, ownerExecutionRevalidation: current.ownerExecutionRevalidation } as never
  const fakeGrant = { grantId: 'g', projectId: f.project.id, policyRevision: current.revision, state: 'active' as const, workspaceId: current.workspaceId, channelId: current.channelId, modelId: current.modelId, executorEmployeeId: current.executorEmployeeId, reviewerEmployeeId: current.reviewerEmployeeId, employeeIds: current.employeeIds, maxCostMicros: current.maxCostMicros, maxRuns: current.maxRuns, maxRework: current.maxRework, expiresAt: current.expiresAt }
  expect(grants.pilotGrantMatchesPolicy(fakeGrant as never, malformed)).toBe(false)
})
test('Given Owner分支purpose=owner_business_execution且无gate When 逐请求核验 Then 拒（休眠语义就绪）', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  expect(() => gates.assertOwnerExecutionRequestGate({ commandPurpose: 'owner_business_execution', sessionId, runtime: 'ai-sdk', modelId: 'model', permissionMode: 'safe', cwd: '/tmp', baseUrl: 'https://example.invalid', requestUrl: 'https://example.invalid' })).toThrow('门禁')
  expect(() => gates.assertOwnerExecutionRequestGate({ commandPurpose: 'controlled_task', sessionId, runtime: 'ai-sdk', modelId: 'model', permissionMode: 'safe', cwd: '/tmp', baseUrl: '', requestUrl: '' })).not.toThrow()
})

test('Given Owner用途工具目录 When 尚未准入或已准入 Then 不向模型宣传不可执行的Bash/Read/MCP', () => {
  expect(gates.getOwnerExecutionToolNames(randomUUID())).toBeNull()
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  expect([...gates.getOwnerExecutionToolNames(sessionId)!]).toEqual([])
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  expect([...gates.getOwnerExecutionToolNames(sessionId)!].sort()).toEqual(['AskUserQuestion', 'Edit', 'ReadKnowledgeSource', 'SearchKnowledge', 'Write'])
})

test('Given无研发范围的Owner执行 When写入风险分级 Then新建和覆盖均须审批', () => {
  const f = fixture(), sessionId = syntheticRunningExecution(f)
  const executionId = (store.getProjectDb().prepare('SELECT id FROM agent_executions WHERE session_id=?').get(sessionId) as { id: string }).id
  gates.admitOwnerExecutionGateSession(executionId, sessionId)
  // 没有显式研发范围，新建普通文件也不能自动获得写权限。
  // 父目录必须已存在（既有候选语义），因此在工作区根下新建。
  expect(gates.classifyOwnerWorkspaceWrite(sessionId, 'Write', { file_path: 'game.html', content: 'x' })).toBe('high')
  expect(gates.isOwnerAutoAllowedWorkspaceWrite(sessionId, 'Write', { file_path: 'game.html', content: 'x' })).toBe(false)
  // 覆盖已有文件：高风险，必须人工审批（写入夹具冻结的那个工作区根）。
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { getAgentWorkspace } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const { getAgentWorkspaceCwd } = require('./agent-workspace-manager') as typeof import('./agent-workspace-manager')
  const frozenWorkspace = getAgentWorkspace(f.record.source.workspaceId)!
  const frozenRoot = getAgentWorkspaceCwd(frozenWorkspace, sessionId)
  mkdirSync(frozenRoot, { recursive: true })
  writeFileSync(join(frozenRoot, 'existing.md'), 'old')
  expect(gates.classifyOwnerWorkspaceWrite(sessionId, 'Write', { file_path: 'existing.md', content: 'new' })).toBe('high')
  // 敏感文件与 Edit 一律高风险。
  expect(gates.classifyOwnerWorkspaceWrite(sessionId, 'Write', { file_path: '.env', content: 'KEY=1' })).toBe('high')
  expect(gates.classifyOwnerWorkspaceWrite(sessionId, 'Edit', { file_path: 'game.html', old_string: 'a', new_string: 'b' })).toBe('high')
  // 工作区外路径不构成候选写入。
  expect(gates.classifyOwnerWorkspaceWrite(sessionId, 'Write', { file_path: '../escape.txt', content: 'x' })).toBeNull()
  expect(() => gates.assertToolAllowedForSessionPurpose(sessionId, 'Edit', { file_path: 'game.html', old_string: 'a', new_string: 'b' })).toThrow('人工审批')
})


test('Given间接执行入口 When分类 Then配置/hooks/脚本不能自动放行而普通页面不受误分类', () => {
  for (const path of ['.github/workflows/ci.yml', 'package.json', '.husky/pre-commit', '.vscode/tasks.json', 'Dockerfile', 'vite.config.ts', 'scripts/install.sh', '.npmrc', 'src/.env.test']) expect(gates.isOwnerHighRiskWritePath(path)).toBe(true)
  for (const path of ['index.html', 'src/game.ts', 'styles.css', 'notes.md']) expect(gates.isOwnerHighRiskWritePath(path)).toBe(false)
})
