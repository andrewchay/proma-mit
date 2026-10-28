import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { approveApproval, createApproval, setApprovedChangeExecutor } from './approval-service'
import { executeApprovedChange } from './proactive-approved-change-executor'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeLearningSample, createProject, createTask, excludeAgentEmployeeLearningSample, initProjectDb, listAgentEmployeeCapabilityVersions, updateAgentEmployee } from './project-sqlite-store'
import { proposeEmployeeCapabilityAdoption } from './agent-employee-capability-service'

const configDir = join(tmpdir(), `gravitas-capability-approval-${randomUUID()}`)
beforeAll(async () => {
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
  setApprovedChangeExecutor((approval) => executeApprovedChange(approval, { createSchedule: () => {} }))
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

test('已停用员工不能执行能力推广', async () => {
  const employee = createAgentEmployee({ name: '停用员工', role: '测试', description: '', channelId: 'channel' })
  updateAgentEmployee(employee.id, { enabled: false })
  const content = '不得被激活。'
  const approval = createApproval({
    sourceType: 'employee_capability',
    title: '推广停用员工能力',
    summary: '测试候选',
    proposedChange: {
      type: 'employee_capability_adopt', agentId: employee.id, scope: 'role', versionNumber: 1,
      content, contentHash: createHash('sha256').update(content).digest('hex'),
    },
  })

  const result = await approveApproval(approval.id)
  expect(result).not.toBeNull()
  expect(result!.executionStatus).toBe('failed')
  expect(result!.executionError).toContain('已停用')
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(0)
})

test('批准员工能力推广后才激活新版本', async () => {
  const employee = createAgentEmployee({ name: '审阅员', role: '测试', description: '', channelId: 'channel' })
  const content = '先运行最小回归，再报告证据。'
  const sampleIds = makeEvidence(employee.id)
  const approval = proposeEmployeeCapabilityAdoption({ agentId: employee.id, scope: 'role', content, trainingScore: 80, heldOutScore: 80, judgeIndependent: true, evidenceSampleIds: sampleIds })
  const result = await approveApproval(approval.approvalId)
  expect(result).toEqual(expect.objectContaining({ status: 'approved', executionStatus: 'succeeded' }))
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'active', content }),
  ]))
})

function makeEvidence(agentId: string): string[] {
  const project = createProject({ title: '证据项目', description: '' })
  const task = createTask(project.id, { title: '任务', description: '' })
  return Array.from({ length: 3 }, () => createAgentEmployeeLearningSample({ agentId, executionId: randomUUID(), projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: '已脱敏', privacyStatus: 'sanitized' }).id)
}

test('Given 候选审批待处理时证据被排除 When 批准 Then 不激活能力', async () => {
  const employee = createAgentEmployee({ name: '证据复核', role: '测试', description: '', channelId: 'channel' })
  const sampleIds = makeEvidence(employee.id)
  const approval = proposeEmployeeCapabilityAdoption({ agentId: employee.id, scope: 'role', content: '先核对证据。', trainingScore: 80, heldOutScore: 80, judgeIndependent: true, evidenceSampleIds: sampleIds })
  excludeAgentEmployeeLearningSample(sampleIds[0]!)
  const result = await approveApproval(approval.approvalId)
  expect(result?.executionStatus).toBe('failed')
  expect(result?.executionError).toContain('证据')
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(0)
})

test('Given 缺少证据引用的旧审批 When 批准 Then 不自动激活能力', async () => {
  const employee = createAgentEmployee({ name: '旧审批', role: '测试', description: '', channelId: 'channel' })
  const content = '旧候选'
  const approval = createApproval({ sourceType: 'employee_capability', title: '旧审批', summary: '无证据', proposedChange: { type: 'employee_capability_adopt', agentId: employee.id, scope: 'role', versionNumber: 1, content, contentHash: createHash('sha256').update(content).digest('hex') } })
  const result = await approveApproval(approval.id)
  expect(result?.executionStatus).toBe('failed')
  expect(result?.executionError).toContain('证据')
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(0)
})
