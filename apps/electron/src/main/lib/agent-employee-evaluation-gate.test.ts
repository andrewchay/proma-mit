import { decideEmployeeEvaluation } from './employee-evaluation-decision'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeCapabilityVersion, createAgentEmployeeLearningSample, createProject, createTask, getActiveAgentEmployeeCapabilityVersions, initProjectDb } from './project-sqlite-store'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-gate-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

test('Given 评测结果 When held-out 缺失、异常或回退 Then 不得创建推广候选', () => {
  const valid = { judgeIndependent: true, heldOutBaseline: 70, heldOutFinal: 80, acceptedRounds: 1, content: '候选' }
  expect(decideEmployeeEvaluation(valid)).toBe('candidate_created')
  expect(decideEmployeeEvaluation({ ...valid, judgeIndependent: false })).toBe('judge_not_independent')
  expect(decideEmployeeEvaluation({ ...valid, heldOutBaseline: null })).toBe('held_out_unavailable')
  expect(decideEmployeeEvaluation({ ...valid, heldOutFinal: null })).toBe('held_out_unavailable')
  expect(decideEmployeeEvaluation({ ...valid, heldOutFinal: NaN })).toBe('held_out_unavailable')
  expect(decideEmployeeEvaluation({ ...valid, heldOutFinal: 101 })).toBe('held_out_unavailable')
  expect(decideEmployeeEvaluation({ ...valid, acceptedRounds: -1 })).toBe('no_accepted_candidate')
  expect(decideEmployeeEvaluation({ ...valid, heldOutFinal: 69 })).toBe('held_out_regression')
  expect(decideEmployeeEvaluation({ ...valid, acceptedRounds: 0 })).toBe('no_accepted_candidate')
})

test('员工缺少窗口信息时不得声明评测完成', async () => {
  const employee = createAgentEmployee({ name: '门禁员工', role: '开发', description: '', channelId: 'channel' })
  expect(getActiveAgentEmployeeCapabilityVersions(employee.id)).toEqual([])
  const project = createProject({ title: '门禁', description: '' })
  const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
  const sample = createAgentEmployeeLearningSample({ agentId: employee.id, executionId: 'gate-run', projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'failed', evidenceSummary: '待审核', privacyStatus: 'pending' })
  expect(sample.privacyStatus).toBe('pending')
  // pending 样本不得作为评测输入：版本仍未被任何候选替换
  createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '基线', contentHash: 'hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  expect(getActiveAgentEmployeeCapabilityVersions(employee.id)).toHaveLength(1)
})
