import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeProjectDb, createProject, createTask, createAgentEmployee, createAgentEmployeeLearningSample, createAgentEmployeeCapabilityVersion, adoptAgentEmployeeCapabilityVersion, getAgentEmployeeCapabilityObservations, initProjectDb, listAgentEmployeeCapabilityRollbackAudits, listAgentEmployeeCapabilityVersions, listAgentEmployeeLearningSamples, reviewAgentEmployeeLearningSample, rollbackAgentEmployeeCapabilityVersion } from './project-sqlite-store'
import { proposeEmployeeCapabilityAdoption } from './agent-employee-capability-service'
import { listApprovals } from './approval-service'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-evolution-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

test('待审核样本经人工摘要后才能标记为已脱敏', () => {
  const project = createProject({ title: '审核', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  const employee = createAgentEmployee({ name: '审核员', role: '测试', description: '', channelId: 'channel' })
  const sample = createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'review-run', projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'failed', evidenceSummary: '待处理', privacyStatus: 'pending' })
  expect(reviewAgentEmployeeLearningSample(sample.id, '已移除路径和原始会话，仅保留测试失败结论。')).toEqual(expect.objectContaining({ privacyStatus: 'sanitized', outcome: 'failed' }))
})

test('能力观察按执行冻结版本归因，人工回滚保留审计', () => {
  const employee = createAgentEmployee({ name: '版本管理员', role: '开发', description: '', channelId: 'channel' })
  const base = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '基线', contentHash: 'base-hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  const active = adoptAgentEmployeeCapabilityVersion({ agentId: employee.id, parentVersionId: base.id, versionNumber: 2, scope: 'role', content: '候选', contentHash: 'candidate-hash', source: 'evolution' })
  const project = createProject({ title: '观察', description: '' })
  const task = createTask(project.id, { title: '观察任务', description: '', priority: 'medium' })
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'observed-run', projectId: project.id, taskId: task.id, capabilityVersionIds: [active.id], outcome: 'changes_requested', evidenceSummary: '返工', privacyStatus: 'pending' })
  expect(getAgentEmployeeCapabilityObservations(employee.id).find((item) => item.versionId === active.id)).toEqual(expect.objectContaining({ changesRequestedSamples: 1, pendingSamples: 1 }))
  const audit = rollbackAgentEmployeeCapabilityVersion(employee.id, active.id, '线上返工率升高，回到稳定基线')
  expect(audit).toEqual(expect.objectContaining({ fromVersionId: active.id, toVersionId: base.id, actorId: 'local-user' }))
  expect(listAgentEmployeeCapabilityVersions(employee.id).find((version) => version.id === base.id)?.status).toBe('active')
  expect(listAgentEmployeeCapabilityRollbackAudits(employee.id)).toHaveLength(1)
})

test('已脱敏样本达到阈值才创建员工能力推广审批', () => {
  const project = createProject({ title: 'P0', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  const employee = createAgentEmployee({ name: '工程师', role: '开发', description: '', channelId: 'channel' })
  for (let i = 0; i < 3; i++) {
    createAgentEmployeeLearningSample({ agentId: employee.id, executionId: `run-${i}`, projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: '已脱敏证据', privacyStatus: 'sanitized' })
  }
  const sampleIds = listAgentEmployeeLearningSamples(employee.id).map((sample) => sample.id)
  const result = proposeEmployeeCapabilityAdoption({ agentId: employee.id, scope: 'role', content: '先核对测试，再交付证据。', trainingScore: 81, heldOutScore: 80, judgeIndependent: true, evidenceSampleIds: sampleIds })
  expect(listApprovals().find((approval) => approval.id === result.approvalId)).toEqual(expect.objectContaining({ sourceType: 'employee_capability', status: 'pending' }))
})
