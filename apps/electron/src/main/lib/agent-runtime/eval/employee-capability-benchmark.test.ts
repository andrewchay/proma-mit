import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildEmployeeCandidateUserPrompt } from './builder-prompts'
import { buildEmployeeCapabilityBenchmarkMaterial, EMPLOYEE_NON_EVOLVABLE_CONSTRAINTS, hashEmployeeCapabilityBenchmarkSplit } from './employee-capability-benchmark'
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

function sample(id: string, privacyStatus: AgentEmployeeLearningSample['privacyStatus'], summary: string, workspaceId?: string): AgentEmployeeLearningSample {
  return { id, agentId: 'employee', executionId: `run-${id}`, projectId: 'project', taskId: 'task', workspaceId, capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: summary, privacyStatus, createdAt: 1 }
}

test('Builder 的真实用户输入只含 train marker，held-out marker 保持隔离', () => {
  const samples = [
    sample('a', 'sanitized', 'TRAIN_OR_HELD_MARKER_A'),
    sample('b', 'sanitized', 'TRAIN_OR_HELD_MARKER_B'),
    sample('c', 'sanitized', 'TRAIN_OR_HELD_MARKER_C'),
    sample('d', 'sanitized', 'TRAIN_OR_HELD_MARKER_D'),
    sample('secret', 'pending', '/Users/private 原始会话'),
  ]
  const material = buildEmployeeCapabilityBenchmarkMaterial({ agentId: 'employee', scope: 'role', samples })
  const trainMarker = material.train[0]!.statement.match(/TRAIN_OR_HELD_MARKER_[A-D]/)?.[0]
  const heldOutMarker = material.heldOut[0]!.statement.match(/TRAIN_OR_HELD_MARKER_[A-D]/)?.[0]

  expect(trainMarker).toBeDefined()
  expect(heldOutMarker).toBeDefined()
  expect(material.evidenceSampleIds).not.toContain('secret')
  const builderInput = buildEmployeeCandidateUserPrompt({
    employeeName: '评测员工',
    scope: 'role',
    currentPrompt: '当前能力',
    caseScores: material.train.map((item) => ({ caseId: item.id, score: 50 })),
    sanitizedLearningSummary: material.sanitizedLearningSummary,
    nonEvolvableConstraints: EMPLOYEE_NON_EVOLVABLE_CONSTRAINTS,
  })

  expect(builderInput).toContain(trainMarker!)
  expect(builderInput).not.toContain(heldOutMarker!)
  expect(builderInput).not.toContain('/Users/private')
  expect(builderInput).toContain('不得修改或绕过权限模式')
})

test('workspace 能力评测只使用产生时冻结在目标工作区的样本', () => {
  const material = buildEmployeeCapabilityBenchmarkMaterial({
    agentId: 'employee',
    scope: 'workspace',
    workspaceId: 'workspace-a',
    samples: [
      sample('a1', 'sanitized', 'A1', 'workspace-a'),
      sample('a2', 'sanitized', 'A2', 'workspace-a'),
      sample('a3', 'sanitized', 'A3', 'workspace-a'),
      sample('b1', 'sanitized', 'B_ONLY_MARKER', 'workspace-b'),
      sample('legacy', 'sanitized', 'UNKNOWN_SCOPE_MARKER'),
    ],
  })

  expect(material.evidenceSampleIds).toEqual(expect.arrayContaining(['a1', 'a2', 'a3']))
  expect(material.evidenceSampleIds).not.toContain('b1')
  expect(material.evidenceSampleIds).not.toContain('legacy')
  expect(material.sanitizedLearningSummary).not.toContain('B_ONLY_MARKER')
  expect(material.sanitizedLearningSummary).not.toContain('UNKNOWN_SCOPE_MARKER')
})

test('train/held-out 划分被冻结并可通过 hash 核验', () => {
  const material = buildEmployeeCapabilityBenchmarkMaterial({ agentId: 'employee', scope: 'role', samples: [sample('a', 'sanitized', 'A'), sample('b', 'sanitized', 'B'), sample('c', 'sanitized', 'C')] })

  expect(Object.isFrozen(material.split)).toBe(true)
  expect(Object.isFrozen(material.split.trainCaseIds)).toBe(true)
  expect(Object.isFrozen(material.split.heldOutCaseIds)).toBe(true)
  expect(material.split.trainCaseIds).toEqual(material.train.map((item) => item.id))
  expect(material.split.heldOutCaseIds).toEqual(material.heldOut.map((item) => item.id))
  expect(material.split.hash).toBe(hashEmployeeCapabilityBenchmarkSplit(material.split))
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
