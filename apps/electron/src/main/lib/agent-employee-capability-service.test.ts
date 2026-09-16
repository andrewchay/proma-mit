import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeProjectDb, createProject, createTask, createAgentEmployee, createAgentEmployeeLearningSample, initProjectDb, listAgentEmployeeLearningSamples, reviewAgentEmployeeLearningSample } from './project-sqlite-store'
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
