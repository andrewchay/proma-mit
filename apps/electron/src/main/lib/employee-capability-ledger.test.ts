import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildEmployeeCapabilityLedger, buildEmployeeCapabilityReviewReport, reviewReportToMarkdown } from './employee-capability-ledger'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeCapabilityVersion, createAgentEmployeeLearningSample, createProject, createTask, deleteAgentEmployeeLearningSamples, initProjectDb, listAgentEmployeeLearningSamples, previewAgentEmployeeLearningSampleRetention } from './project-sqlite-store'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-ledger-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

test('保留期未配置时不清理；配置后只预览，显式删除才生效', () => {
  const employee = createAgentEmployee({ name: '保留期', role: '开发', description: '', channelId: 'channel' })
  const project = createProject({ title: '保留期项目', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'ret-1', projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: '结论', privacyStatus: 'sanitized' })
  expect(previewAgentEmployeeLearningSampleRetention(employee.id, null).expired).toBe(0)
  // 用 0 天窗口模拟全部过期，仅验证预览与显式删除，不代表默认策略。
  const preview = previewAgentEmployeeLearningSampleRetention(employee.id, 1, Date.now() + 10 * 24 * 60 * 60 * 1000)
  expect(preview.expired).toBe(1)
  expect(listAgentEmployeeLearningSamples(employee.id)).toHaveLength(1)
  expect(deleteAgentEmployeeLearningSamples(preview.expiredIds)).toBe(1)
  expect(listAgentEmployeeLearningSamples(employee.id)).toHaveLength(0)
})

test('台账按员工归集版本、样本、审批与观察，报告不含摘要正文', () => {
  const employee = createAgentEmployee({ name: '台账员工', role: '开发', description: '', channelId: 'channel' })
  createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '能力文本', contentHash: 'hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  const project = createProject({ title: '台账项目', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'led-1', projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'changes_requested', evidenceSummary: '包含敏感路径 /Users/secret 的摘要', privacyStatus: 'sanitized' })
  const entry = buildEmployeeCapabilityLedger(employee.id, 30)
  expect(entry.versions.active).toBe(1)
  expect(entry.samples.sanitized).toBe(1)
  expect(entry.reviewEffortProxy).toBe(1)

  const report = buildEmployeeCapabilityReviewReport({ agentIds: [employee.id] })
  const markdown = reviewReportToMarkdown(report)
  expect(markdown).toContain('台账员工')
  expect(markdown).not.toContain('/Users/secret')
  expect(markdown).not.toContain('能力文本')
  expect(report.disclaimer).toContain('代理指标')
})
