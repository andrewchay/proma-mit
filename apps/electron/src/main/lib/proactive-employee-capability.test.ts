import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { approveApproval, createApproval, setApprovedChangeExecutor } from './approval-service'
import { executeApprovedChange } from './proactive-approved-change-executor'
import { closeProjectDb, createAgentEmployee, initProjectDb, listAgentEmployeeCapabilityVersions, updateAgentEmployee } from './project-sqlite-store'

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
  const approval = createApproval({
    sourceType: 'employee_capability',
    title: '推广能力',
    summary: '测试候选',
    proposedChange: {
      type: 'employee_capability_adopt', agentId: employee.id, scope: 'role', versionNumber: 1,
      content, contentHash: createHash('sha256').update(content).digest('hex'),
    },
  })
  const result = await approveApproval(approval.id)
  expect(result).toEqual(expect.objectContaining({ status: 'approved', executionStatus: 'succeeded' }))
  expect(listAgentEmployeeCapabilityVersions(employee.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'active', content }),
  ]))
})
