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
