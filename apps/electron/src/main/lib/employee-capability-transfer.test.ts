import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createTransferCandidate, prepareCapabilityTransfer } from './employee-capability-transfer'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeLearningSample, createProject, createTask, initProjectDb, listAgentEmployeeLearningSamples } from './project-sqlite-store'
import { resetGovernancePolicyForTests } from './employee-capability-governance-policy'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-transfer-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

function seed(agentId: string, count: number): string[] {
  const project = createProject({ title: `迁移-${agentId}`, description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const sample = createAgentEmployeeLearningSample({ agentId, executionId: `${agentId}-t-${i}`, projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: '脱敏结论', privacyStatus: 'sanitized' })
    ids.push(sample.id)
  }
  return ids
}

test('跨员工迁移默认关闭，且不复制来源分数', () => {
  const source = createAgentEmployee({ name: '来源', role: '开发', description: '', channelId: 'channel' })
  const target = createAgentEmployee({ name: '目标', role: '开发', description: '', channelId: 'channel' })
  seed(source.id, 3)
  expect(prepareCapabilityTransfer({ sourceAgentId: source.id, targetAgentId: target.id, scope: 'role', allowTransfer: false })).toEqual(expect.objectContaining({ status: 'disabled' }))

  const targetInsufficient = prepareCapabilityTransfer({ sourceAgentId: source.id, targetAgentId: target.id, scope: 'role', allowTransfer: true })
  expect(targetInsufficient.status).toBe('target_insufficient')
  expect(targetInsufficient.requiredSteps?.length).toBeGreaterThan(0)

  const targetIds = seed(target.id, 3)
  const prepared = prepareCapabilityTransfer({ sourceAgentId: source.id, targetAgentId: target.id, scope: 'role', allowTransfer: true })
  expect(prepared.status).toBe('prepared')
  expect(prepared.patternSummary).toContain('来源员工')
  expect(prepared.patternSummary).not.toContain('脱敏结论')

  resetGovernancePolicyForTests()
  expect(() => createTransferCandidate({ targetAgentId: target.id, scope: 'role', content: '迁移能力', trainingScore: 90, heldOutScore: 90, judgeIndependent: false, evidenceSampleIds: targetIds })).toThrow('评判者不独立')
})

test('迁移候选必须引用目标员工自己的已脱敏样本', () => {
  const source = createAgentEmployee({ name: '来源2', role: '开发', description: '', channelId: 'channel' })
  const target = createAgentEmployee({ name: '目标2', role: '开发', description: '', channelId: 'channel' })
  const sourceIds = seed(source.id, 3)
  seed(target.id, 3)
  expect(() => createTransferCandidate({ targetAgentId: target.id, scope: 'role', content: '迁移能力', trainingScore: 90, heldOutScore: 90, judgeIndependent: true, evidenceSampleIds: sourceIds })).toThrow('目标员工自己')
  expect(listAgentEmployeeLearningSamples(target.id).every((sample) => sample.privacyStatus === 'sanitized')).toBe(true)
})
