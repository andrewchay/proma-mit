import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeCapabilityVersion, createAgentEmployeeLearningSample, createProject, createTask, getAgentEmployeeCapabilityHealth, initProjectDb } from './project-sqlite-store'
import { disableEmployeeCanary, enableEmployeeCanary, evaluateCanaryStopCondition, pauseEmployeeCanary, resetEmployeeCanaryForTests, shouldUseCanary } from './agent-employee-canary'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-obs-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})
beforeEach(() => resetEmployeeCanaryForTests())

test('样本量不足时不声称趋势可信，且取消不计入失败率', () => {
  const employee = createAgentEmployee({ name: '观察', role: '开发', description: '', channelId: 'channel' })
  const version = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '能力', contentHash: 'hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  const project = createProject({ title: '观察项目', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'obs-run-1', projectId: project.id, taskId: task.id, capabilityVersionIds: [version.id], outcome: 'changes_requested', evidenceSummary: '返工', privacyStatus: 'sanitized' })
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'obs-run-2', projectId: project.id, taskId: task.id, capabilityVersionIds: [version.id], outcome: 'cancelled', evidenceSummary: '用户取消', privacyStatus: 'pending' })
  const health = getAgentEmployeeCapabilityHealth(employee.id, 30).find((item) => item.versionId === version.id)
  expect(health).toEqual(expect.objectContaining({ decidedSampleCount: 1, sampleSufficient: false, reworkRate: 1, failureRate: 0 }))
})

test('同 scope 版本对比标注可比性，样本不足时不制造改善错觉', () => {
  const employee = createAgentEmployee({ name: '对比', role: '开发', description: '', channelId: 'channel' })
  const project = createProject({ title: '对比项目', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  const baseline = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '基线', contentHash: 'b', status: 'superseded', source: 'manual', activatedAt: Date.now() })
  const candidate = createAgentEmployeeCapabilityVersion({ agentId: employee.id, parentVersionId: baseline.id, versionNumber: 2, scope: 'role', content: '候选', contentHash: 'c', status: 'active', source: 'manual', activatedAt: Date.now() })
  // 各 1 条已判定样本：远不足以声称改善。
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'cmp-1', projectId: project.id, taskId: task.id, capabilityVersionIds: [baseline.id], outcome: 'changes_requested', evidenceSummary: '返工', privacyStatus: 'sanitized' })
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'cmp-2', projectId: project.id, taskId: task.id, capabilityVersionIds: [candidate.id], outcome: 'accepted', evidenceSummary: '通过', privacyStatus: 'sanitized' })
  const health = getAgentEmployeeCapabilityHealth(employee.id, 30).find((item) => item.versionId === candidate.id)
  expect(health?.comparisonVersionId).toBe(baseline.id)
  expect(health?.reworkRateDelta).toBe(-1)
  expect(health?.comparisonComparable).toBe(false)
})

test('Canary 默认关闭、显式启用后确定性分流，且只暂停不自动回滚', () => {
  const config = enableEmployeeCanary({ agentId: 'agent', scope: 'role', candidateVersionId: 'v2', percent: 30 })
  expect(shouldUseCanary(config, 'task-1')).toBe(shouldUseCanary(config, 'task-1'))
  expect(evaluateCanaryStopCondition(config, { failureRate: 0.5, reworkRate: 0 })).toEqual(expect.objectContaining({ shouldPause: true }))
  const paused = pauseEmployeeCanary('agent', 'role', '失败率超过上限')
  expect(paused).toEqual(expect.objectContaining({ enabled: false, pausedReason: '失败率超过上限' }))
  expect(shouldUseCanary(paused!, 'task-1')).toBe(false)
  const disabled = disableEmployeeCanary('agent', 'role')
  expect(disabled?.enabled).toBe(false)
  expect(() => enableEmployeeCanary({ agentId: 'agent', scope: 'role', candidateVersionId: 'v2', percent: 0 })).toThrow('Canary 百分比')
})
