import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { approveApproval, createApproval, getPendingApprovals, setApprovedChangeExecutor } from './approval-service'
import { executeApprovedChange } from './proactive-approved-change-executor'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeLearningSample, createProject, createTask, excludeAgentEmployeeLearningSample, getProjectDb, initProjectDb, listAgentEmployeeCapabilityVersions, reviewAgentEmployeeLearningSample, updateAgentEmployee } from './project-sqlite-store'
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

  const result = await approveApproval(approval.id, '该员工已停用，记录拒绝尝试')
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
  await expect(approveApproval(approval.approvalId)).rejects.toThrow('必须填写审批理由')
  const pending = getPendingApprovals()
  expect(pending.some((item) => item.id === approval.approvalId)).toBe(true)
  const result = await approveApproval(approval.approvalId, '已核对证据与 held-out 结果，允许限定角色范围试用')
  expect(result).toEqual(expect.objectContaining({ status: 'approved', executionStatus: 'succeeded', decisionReason: '已核对证据与 held-out 结果，允许限定角色范围试用' }))
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'active', content }),
  ]))
  const audit = getProjectDb().prepare("SELECT action, reason, actor_id FROM agent_employee_capability_audits WHERE agent_id = ? AND action = 'adopt'").get(employee.id) as { action: string; reason: string; actor_id: string }
  expect(audit).toEqual({ action: 'adopt', reason: '已核对证据与 held-out 结果，允许限定角色范围试用', actor_id: 'local-user' })
})

test('能力推广审批理由缺失或超长时不改变待审批状态', async () => {
  const employee = createAgentEmployee({ name: '理由必填', role: '测试', description: '', channelId: 'channel' })
  const sampleIds = makeEvidence(employee.id)
  const approval = proposeEmployeeCapabilityAdoption({ agentId: employee.id, scope: 'role', content: '先核对证据。', trainingScore: 80, heldOutScore: 80, judgeIndependent: true, evidenceSampleIds: sampleIds })
  await expect(approveApproval(approval.approvalId, '   ')).rejects.toThrow('必须填写审批理由')
  await expect(approveApproval(approval.approvalId, '理'.repeat(1001))).rejects.toThrow('不能超过 1000 字')
  expect(getPendingApprovals().some((item) => item.id === approval.approvalId)).toBe(true)
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(0)
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
  const result = await approveApproval(approval.approvalId, '复核前证据已排除，拒绝执行')
  expect(result?.executionStatus).toBe('failed')
  expect(result?.executionError).toContain('证据')
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(0)
})

test('Given 候选审批待处理时证据摘要被修改 When 批准 Then 不激活旧候选', async () => {
  const employee = createAgentEmployee({ name: '证据漂移', role: '测试', description: '', channelId: 'channel' })
  const sampleIds = makeEvidence(employee.id)
  const approval = proposeEmployeeCapabilityAdoption({ agentId: employee.id, scope: 'role', content: '先核对证据。', trainingScore: 80, heldOutScore: 80, judgeIndependent: true, evidenceSampleIds: sampleIds })
  reviewAgentEmployeeLearningSample(sampleIds[0]!, '已重新审核的新摘要')
  const result = await approveApproval(approval.approvalId, '证据摘要已变化，拒绝旧候选')
  expect(result?.executionStatus).toBe('failed')
  expect(result?.executionError).toContain('证据')
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(0)
})

test('Given 缺少证据引用的旧审批 When 批准 Then 不自动激活能力', async () => {
  const employee = createAgentEmployee({ name: '旧审批', role: '测试', description: '', channelId: 'channel' })
  const content = '旧候选'
  const approval = createApproval({ sourceType: 'employee_capability', title: '旧审批', summary: '无证据', proposedChange: { type: 'employee_capability_adopt', agentId: employee.id, scope: 'role', versionNumber: 1, content, contentHash: createHash('sha256').update(content).digest('hex') } })
  const result = await approveApproval(approval.id, '补充记录理由后检查旧候选证据')
  expect(result?.executionStatus).toBe('failed')
  expect(result?.executionError).toContain('证据')
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(0)
})
