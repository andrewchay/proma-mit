import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeLearningSample, createProject, createTask, initProjectDb, listAgentEmployeeLearningSamples } from './project-sqlite-store'
import { resetEmployeeCapabilityScanStateForTests, scanEmployeeCapabilityScope } from './employee-capability-recommendation-service'
import { createApproval, listApprovals } from './approval-service'
import { resetRecommendationServiceForTests } from './recommendation-service'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-scan-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})
beforeEach(() => {
  resetRecommendationServiceForTests()
  resetEmployeeCapabilityScanStateForTests()
})

function seedSanitized(agentId: string, count: number): void {
  const project = createProject({ title: `扫描-${agentId}`, description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  for (let i = 0; i < count; i++) {
    createAgentEmployeeLearningSample({ agentId, executionId: `${agentId}-run-${i}`, projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: '已脱敏结论', privacyStatus: 'sanitized' })
  }
}

test('样本不足时不产生评测建议，也不调用模型', () => {
  const employee = createAgentEmployee({ name: '样本不足', role: '开发', description: '', channelId: 'channel' })
  seedSanitized(employee.id, 2)
  expect(scanEmployeeCapabilityScope({ agentId: employee.id, scope: 'role' })).toEqual(expect.objectContaining({ skipped: 'below_threshold' }))
})

test('冷却期内不重复建议，冷却结束后同一 scope 只并发一个', () => {
  const employee = createAgentEmployee({ name: '冷却', role: '开发', description: '', channelId: 'channel' })
  seedSanitized(employee.id, 3)
  const first = scanEmployeeCapabilityScope({ agentId: employee.id, scope: 'role' })
  expect(first.recommendationId).toBeTruthy()
  expect(scanEmployeeCapabilityScope({ agentId: employee.id, scope: 'role' })).toEqual(expect.objectContaining({ skipped: 'cooldown' }))
})

test('存在待审批候选或超出每日预算时不再建议', () => {
  const employee = createAgentEmployee({ name: '预算', role: '开发', description: '', channelId: 'channel' })
  seedSanitized(employee.id, 3)
  resetEmployeeCapabilityScanStateForTests()
  createApproval({ sourceType: 'employee_capability', title: '待审批', summary: '待审批', proposedChange: { type: 'employee_capability_adopt', agentId: employee.id } })
  expect(listApprovals().some((approval) => approval.sourceType === 'employee_capability' && approval.status === 'pending')).toBe(true)
  expect(scanEmployeeCapabilityScope({ agentId: employee.id, scope: 'role' })).toEqual(expect.objectContaining({ skipped: 'pending_duplicate' }))
})

test('扫描只读本地元数据，不改变样本状态', () => {
  const employee = createAgentEmployee({ name: '只读', role: '开发', description: '', channelId: 'channel' })
  seedSanitized(employee.id, 3)
  const before = listAgentEmployeeLearningSamples(employee.id).map((sample) => sample.privacyStatus).join(',')
  scanEmployeeCapabilityScope({ agentId: employee.id, scope: 'role' })
  const after = listAgentEmployeeLearningSamples(employee.id).map((sample) => sample.privacyStatus).join(',')
  expect(after).toBe(before)
})
