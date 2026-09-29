import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPilotControlSnapshot } from './project-pilot-control'
import { confirmPilotGrantIssue, previewPilotGrantIssue } from './project-pilot-grant-issue'
import { previewPilotGrantPauseImpact } from './project-pilot-grant-pause'
import { savePilotPolicyDraft } from './project-pilot-policy'
import { closeProjectDb, createProject, getProjectDb, initProjectDb } from './project-sqlite-store'

const directory = mkdtempSync(join(tmpdir(), 'pilot-control-'))
const previousDirectory = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previousDirectory === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

test('Given 项目经理打开概览 When 尚无策略 Then 控制面明确阻塞且没有活动授权', () => {
  const project = createProject({ title: '未配置项目', description: '' })
  const snapshot = getPilotControlSnapshot(project.id)
  expect(snapshot.policy).toBeNull()
  expect(snapshot.readiness.bindingsValid).toBe(false)
  expect(snapshot.readiness.blockers).toContain('尚未保存 Pilot 策略草案')
  expect(snapshot.activeGrant).toBeNull()
  expect(snapshot.grantStatus).toBe('none')
  expect(snapshot.budgetUsage).toBeNull()
  expect(snapshot.stopReconciliation).toEqual([])
})

test('Given 已确认活动授权 When 项目经理刷新控制面 Then 展示冻结边界但不伪报绑定就绪', () => {
  const now = Date.now()
  const project = createProject({ title: '已授权项目', description: '' })
  const policy = savePilotPolicyDraft(project.id, {
    workspaceId: 'workspace-a', employeeIds: ['executor', 'reviewer'],
    executorEmployeeId: 'executor', reviewerEmployeeId: 'reviewer', channelId: 'channel-a', modelId: 'model-a',
    maxCostMicros: 2_000_000, maxRuns: 2, maxRework: 1, expiresAt: now + 100_000,
  }, null)
  const ready = (projectId: string) => ({ projectId, policyRevision: policy.revision, bindingsValid: true, blockers: [] })
  const preview = previewPilotGrantIssue(project.id, policy.revision, now, ready)
  const grant = confirmPilotGrantIssue(preview, preview.approvalFingerprint, now, ready)

  const snapshot = getPilotControlSnapshot(project.id, now)
  expect(snapshot.policy?.revision).toBe(policy.revision)
  expect(snapshot.activeGrant).toEqual(grant)
  expect(snapshot.readiness.bindingsValid).toBe(false)
  expect(snapshot.readiness.blockers).toContain('执行工作区不存在')
  expect(snapshot.grantStatus).toBe('needs_reconcile')
  expect(getPilotControlSnapshot(project.id, policy.expiresAt).grantStatus).toBe('expired')
  // 消耗合计与活动授权绑定：刚发行时零占用、全部额度剩余、无命令明细。
  expect(snapshot.budgetUsage).toMatchObject({
    grantId: grant.grantId, state: 'active', maxCostMicros: 2_000_000, maxRuns: 2,
    usedRuns: 0, committedCostMicros: 0, remainingCostMicros: 2_000_000, remainingRuns: 2,
  })
  expect(snapshot.budgetUsage?.commands).toEqual([])
})

test('Given 已暂停的停止决策 When 重启刷新控制面 Then 无活动授权仍展示人工对账', async () => {
  const now = Date.now()
  const project = createProject({ title: '停止对账项目', description: '' })
  getProjectDb().prepare(`INSERT INTO pilot_runtime_grants
    (id, project_id, policy_revision, state, workspace_id, channel_id, model_id,
     executor_employee_id, reviewer_employee_id, max_cost_micros, max_runs, max_rework, expires_at, created_at)
    VALUES (?, ?, 1, 'active', 'workspace-a', 'channel-a', 'model-a',
      'executor', 'reviewer', 10000, 1, 0, ?, ?)`).run(`grant-${project.id}`, project.id, now + 100000, now)
  const grantId = `grant-${project.id}`
  getProjectDb().prepare(`INSERT INTO pilot_grant_pause_decisions
    (grant_id, project_id, policy_revision, fingerprint, queued_targets, running_choices, created_at)
    VALUES (?, ?, 1, 'fixture', '{"reservedCommandIds":[],"queued":[]}', ?, ?)`).run(
    grantId, project.id, JSON.stringify([{ executionId: 'run-a', disposition: 'request_stop' }]), now)
  expect(getPilotControlSnapshot(project.id).stopReconciliation).toMatchObject([
    { grantId, executionId: 'run-a', state: 'legacy_unknown' },
  ])
  getProjectDb().exec('DROP TABLE pilot_grant_stop_requests')
  closeProjectDb()
  await initProjectDb()
  expect(getPilotControlSnapshot(project.id).stopReconciliation).toMatchObject([
    { grantId, executionId: 'run-a', state: 'legacy_unknown' },
  ])
})


test('Given 旧库活动授权缺少确认指纹 When 打开控制面 Then 标记需对账且仍可预览保守暂停', () => {
  const now = Date.now()
  const project = createProject({ title: '旧授权项目', description: '' })
  const policy = savePilotPolicyDraft(project.id, {
    workspaceId: 'workspace-legacy', employeeIds: ['executor', 'reviewer'],
    executorEmployeeId: 'executor', reviewerEmployeeId: 'reviewer', channelId: 'channel-a', modelId: 'model-a',
    maxCostMicros: 1_000_000, maxRuns: 1, maxRework: 0, expiresAt: now + 100_000,
  }, null)
  getProjectDb().prepare(`INSERT INTO pilot_runtime_grants
    (id, project_id, policy_revision, state, workspace_id, channel_id, model_id,
     executor_employee_id, reviewer_employee_id, max_cost_micros, max_runs, max_rework,
     expires_at, approval_fingerprint, created_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(
    'legacy-grant', project.id, policy.revision, policy.workspaceId, policy.channelId, policy.modelId,
    policy.executorEmployeeId!, policy.reviewerEmployeeId!, policy.maxCostMicros, policy.maxRuns,
    policy.maxRework, policy.expiresAt, now,
  )

  const snapshot = getPilotControlSnapshot(project.id, now)
  expect(snapshot.activeGrant?.approvalFingerprint).toBeNull()
  expect(snapshot.grantStatus).toBe('needs_reconcile')
  expect(previewPilotGrantPauseImpact('legacy-grant').projectId).toBe(project.id)
})
