import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildBuilderUserPrompt } from './builder-prompts'
import { buildEmployeeCapabilityBenchmarkMaterial, EMPLOYEE_NON_EVOLVABLE_CONSTRAINTS } from './employee-capability-benchmark'
import { buildEmployeeCapabilityStateGuard } from './employee-capability-state'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeCapabilityVersion, getActiveAgentEmployeeCapabilityVersions, initProjectDb } from '../../project-sqlite-store'
import type { AgentEmployeeLearningSample } from '../../project-types'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-eval-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

function sample(id: string, privacyStatus: AgentEmployeeLearningSample['privacyStatus'], summary: string): AgentEmployeeLearningSample {
  return { id, agentId: 'employee', executionId: `run-${id}`, projectId: 'project', taskId: 'task', capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: summary, privacyStatus, createdAt: 1 }
}

test('只用已脱敏样本构建互斥 train/held-out，并把治理约束传给 Builder', () => {
  const material = buildEmployeeCapabilityBenchmarkMaterial({ agentId: 'employee', scope: 'role', samples: [sample('a', 'sanitized', '先验证'), sample('b', 'sanitized', '不臆造'), sample('c', 'sanitized', '说明未运行'), sample('secret', 'pending', '/Users/private 原始会话')] })
  expect(material.train.length).toBeGreaterThan(0)
  expect(material.heldOut.length).toBeGreaterThan(0)
  expect(material.evidenceSampleIds).not.toContain('secret')
  const prompt = buildBuilderUserPrompt({ benchmark: { id: 'employee', title: '', description: '', targetAgentId: 'employee', runtime: { provider: 'test', modelId: 'test' }, runsPerCase: 1, targetScore: 80, cases: [], createdAt: '', updatedAt: '' }, currentPrompt: '当前能力', caseScores: [], sanitizedLearningSummary: material.sanitizedLearningSummary, nonEvolvableConstraints: EMPLOYEE_NON_EVOLVABLE_CONSTRAINTS })
  expect(prompt).not.toContain('/Users/private')
  expect(prompt).toContain('不得修改或绕过权限模式')
})

test('员工能力 StateGuard 只改内存，restore 后生产 active 版本不变', async () => {
  const employee = createAgentEmployee({ name: '评测员工', role: '开发', description: '', channelId: 'channel' })
  const production = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '生产能力', contentHash: 'hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  const guard = buildEmployeeCapabilityStateGuard({ type: 'employee_capability', id: employee.id, scope: 'role' })
  await guard.snapshot('before')
  await guard.apply({ description: '候选', target: employee.id, afterState: { prompt: '候选能力' } })
  expect(guard.currentContent()).toBe('候选能力')
  expect(getActiveAgentEmployeeCapabilityVersions(employee.id)[0]?.id).toBe(production.id)
  await guard.restore()
  expect(guard.currentContent()).toBe('生产能力')
})
