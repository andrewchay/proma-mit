import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeProjectDb, createAgentEmployee, createAgentEmployeeCapabilityVersion, createAgentEmployeeLearningSample, createProject, createTask, getAgentEmployeeCapabilityHealth, getAgentEmployeeCapabilityObservations, initProjectDb, listAgentEmployeeLearningSamples } from './project-sqlite-store'
import { exportEvolutionPackage } from './employee-capability-portability'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-scale-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
}, 30_000)
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

test('多员工多版本下的观察、健康与导出保持可用且规模已记录', () => {
  const agents = 6
  const versionsPerAgent = 4
  const samplesPerAgent = 40
  const agentIds: string[] = []
  for (let a = 0; a < agents; a++) {
    const employee = createAgentEmployee({ name: `规模员工-${a}`, role: '开发', description: '', channelId: 'channel' })
    agentIds.push(employee.id)
    const project = createProject({ title: `规模项目-${a}`, description: '' })
    const task = createTask(project.id, { title: '任务', description: '', priority: 'medium' })
    const versionIds: string[] = []
    for (let v = 0; v < versionsPerAgent; v++) {
      const version = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: v + 1, scope: 'role', content: `能力 v${v + 1}`, contentHash: `hash-${a}-${v}`, status: v === versionsPerAgent - 1 ? 'active' : 'superseded', source: 'manual', activatedAt: Date.now() })
      versionIds.push(version.id)
    }
    for (let s = 0; s < samplesPerAgent; s++) {
      createAgentEmployeeLearningSample({ agentId: employee.id, executionId: `scale-${a}-${s}`, projectId: project.id, taskId: task.id, capabilityVersionIds: [versionIds[s % versionIds.length]!], outcome: s % 3 === 0 ? 'changes_requested' : 'accepted', evidenceSummary: '脱敏结论', privacyStatus: 'sanitized' })
    }
  }

  const startedAt = Date.now()
  for (const agentId of agentIds) {
    expect(getAgentEmployeeCapabilityObservations(agentId)).toHaveLength(versionsPerAgent)
    expect(getAgentEmployeeCapabilityHealth(agentId, 30)).toHaveLength(versionsPerAgent)
    expect(listAgentEmployeeLearningSamples(agentId)).toHaveLength(samplesPerAgent)
  }
  const pkg = exportEvolutionPackage({ agentIds })
  const elapsedMs = Date.now() - startedAt

  expect(pkg.agents).toHaveLength(agents)
  expect(pkg.agents[0]!.samples).toHaveLength(samplesPerAgent)
  // 记录基线耗时：120 条样本 × 6 员工的只读聚合应在数秒内完成。
  expect(elapsedMs).toBeLessThan(10_000)
  console.log(`[规模基线] ${agents} 员工 / ${versionsPerAgent} 版本 / ${samplesPerAgent} 样本：只读聚合 + 导出 ${elapsedMs}ms`)
}, 60_000)
