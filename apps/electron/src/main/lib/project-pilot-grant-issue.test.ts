import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmPilotGrantIssue, previewPilotGrantIssue } from './project-pilot-grant-issue'
import { savePilotPolicyDraft } from './project-pilot-policy'
import { closeProjectDb, createProject, getProjectDb, initProjectDb } from './project-sqlite-store'

const directory = mkdtempSync(join(tmpdir(), 'pilot-grant-issue-'))
const previousDirectory = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previousDirectory === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

const now = Date.now()
const ready = (projectId: string, _now: number) => ({
  projectId, policyRevision: 1, bindingsValid: true, blockers: [],
})
const draft = (expiresAt = now + 100_000) => ({
  workspaceId: 'workspace-a', employeeIds: ['executor', 'reviewer'],
  executorEmployeeId: 'executor', reviewerEmployeeId: 'reviewer',
  channelId: 'channel-a', modelId: 'model-a', maxCostMicros: 1_000,
  maxRuns: 2, maxRework: 1, expiresAt,
})

test('Given 已复核暂停草案 When 用户按冻结指纹确认 Then 幂等发行活动 grant 且不创建命令', () => {
  const project = createProject({ title: '发行项目', description: '' })
  const policy = savePilotPolicyDraft(project.id, draft(), null)
  const preview = previewPilotGrantIssue(project.id, policy.revision, now, ready)
  const first = confirmPilotGrantIssue(preview, preview.approvalFingerprint, now, ready)
  expect(first.state).toBe('active')
  expect(first.policyRevision).toBe(policy.revision)
  expect(confirmPilotGrantIssue(preview, preview.approvalFingerprint, now, ready)).toEqual(first)
  expect(() => savePilotPolicyDraft(project.id, { ...draft(), maxRuns: 3 }, policy.revision))
    .toThrow('请先预览影响面并暂停')
  getProjectDb().prepare('UPDATE pilot_runtime_grants SET max_runs = 99 WHERE id = ?').run(first.grantId)
  expect(() => confirmPilotGrantIssue(preview, preview.approvalFingerprint, now, ready))
    .toThrow('授权与确认内容不一致')
  expect(getProjectDb().prepare('SELECT COUNT(*) AS count FROM pilot_runtime_grants WHERE project_id = ?')
    .get(project.id)).toEqual({ count: 1 })
  expect(getProjectDb().prepare('SELECT COUNT(*) AS count FROM pilot_commands WHERE project_id = ?')
    .get(project.id)).toEqual({ count: 0 })
})

test('Given 旧确认或绑定失败 When 发行 Then 不产生部分活动授权', () => {
  const project = createProject({ title: '拒绝旧确认', description: '' })
  const policy = savePilotPolicyDraft(project.id, draft(), null)
  const preview = previewPilotGrantIssue(project.id, policy.revision, now, ready)
  expect(() => confirmPilotGrantIssue(preview, 'a'.repeat(64), now, ready)).toThrow('确认指纹无效')
  const blocked = (projectId: string, _now: number) => ({
    projectId, policyRevision: 1, bindingsValid: false, blockers: ['员工已停用'],
  })
  expect(() => confirmPilotGrantIssue(preview, preview.approvalFingerprint, now, blocked)).toThrow('预检未通过')
  expect(getProjectDb().prepare('SELECT COUNT(*) AS count FROM pilot_runtime_grants WHERE project_id = ?')
    .get(project.id)).toEqual({ count: 0 })
})

test('Given 草案已修改或项目已有其他活动授权 When 确认 Then 必须重新确认或先暂停旧授权', () => {
  const project = createProject({ title: '并发修改', description: '' })
  const policy = savePilotPolicyDraft(project.id, draft(), null)
  const preview = previewPilotGrantIssue(project.id, policy.revision, now, ready)
  savePilotPolicyDraft(project.id, { ...draft(), maxRuns: 3 }, policy.revision)
  expect(() => confirmPilotGrantIssue(preview, preview.approvalFingerprint, now, ready)).toThrow('版本已变化')

  const other = createProject({ title: '已有授权', description: '' })
  const current = savePilotPolicyDraft(other.id, draft(), null)
  const currentPreview = previewPilotGrantIssue(other.id, current.revision, now, ready)
  getProjectDb().prepare(`INSERT INTO pilot_runtime_grants
    (id, project_id, policy_revision, state, workspace_id, channel_id, model_id,
     executor_employee_id, reviewer_employee_id, max_cost_micros, max_runs, max_rework,
     expires_at, approval_fingerprint, created_at)
    VALUES ('other-grant', ?, 99, 'active', 'workspace-a', 'channel-a', 'model-a',
      'executor', 'reviewer', 1000, 2, 1, ?, ?, ?)`).run(
    other.id, now + 100_000, 'b'.repeat(64), now,
  )
  expect(() => confirmPilotGrantIssue(currentPreview, currentPreview.approvalFingerprint, now, ready))
    .toThrow('须先对账并暂停')
})

test('Given 旧数据库 When 初始化 Then grant 确认指纹列已迁移', () => {
  const columns = getProjectDb().prepare('PRAGMA table_info(pilot_runtime_grants)').all() as Array<{ name: string }>
  expect(columns.map((item) => item.name)).toContain('approval_fingerprint')
  const commandColumns = getProjectDb().prepare('PRAGMA table_info(pilot_commands)').all() as Array<{ name: string }>
  expect(commandColumns.map((item) => item.name)).toContain('usage_evidence')
})
