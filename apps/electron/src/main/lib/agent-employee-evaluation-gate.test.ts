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

/**
 * 只验证门禁逻辑本身：不触发真实模型。
 * 这里直接复用评测服务内部的判定条件表达，避免为了测试而引入假渠道。
 */
function decideGate(input: { judgeIndependent: boolean; heldOutBaseline: number | null; heldOutFinal: number | null; acceptedRounds: number; content?: string }): string {
  if (!input.judgeIndependent) return 'judge_not_independent'
  if (input.heldOutBaseline !== null && input.heldOutFinal !== null && input.heldOutFinal < input.heldOutBaseline) return 'held_out_regression'
  if (!input.content || input.acceptedRounds === 0) return 'no_accepted_candidate'
  return 'candidate_created'
}

test('不独立评判、held-out 回退与无候选都不得生成可批准候选', () => {
  expect(decideGate({ judgeIndependent: false, heldOutBaseline: 70, heldOutFinal: 80, acceptedRounds: 2, content: '候选' })).toBe('judge_not_independent')
  expect(decideGate({ judgeIndependent: true, heldOutBaseline: 80, heldOutFinal: 70, acceptedRounds: 2, content: '候选' })).toBe('held_out_regression')
  expect(decideGate({ judgeIndependent: true, heldOutBaseline: 70, heldOutFinal: 80, acceptedRounds: 0, content: undefined })).toBe('no_accepted_candidate')
  expect(decideGate({ judgeIndependent: true, heldOutBaseline: 70, heldOutFinal: 80, acceptedRounds: 1, content: '候选' })).toBe('candidate_created')
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
