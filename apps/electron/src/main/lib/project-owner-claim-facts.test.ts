import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnerExecutionObservation } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-claim-facts-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const management = await import('./project-owner-management-store')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
await store.initProjectDb()
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

function projectWithOwner() {
  const project = store.createProject({ title: '事实核对夹具', description: '' })
  management.recordOwnerManagementGoal(saveProjectOwnerGoalDraft(project.id, 0, { objective: '交付可核验说明' }))
  return project
}
function observation(overrides: Partial<OwnerExecutionObservation> = {}): OwnerExecutionObservation {
  return {
    executionId: 'execution-1', commandId: 'command-1', grantId: 'grant-1', sourcePlanRevision: 2,
    businessTaskId: 'task-1', taskTitle: '研究材料', role: 'executor', trigger: 'terminal',
    executionStatus: 'failed', commandState: 'needs_reconcile', grantState: 'needs_reconcile',
    completedAt: 1, resultSummary: '', error: '合成失败原因', actualCostMicros: null, reservedCostMicros: 500,
    ...overrides,
  }
}
function contents(projectId: string): string {
  const rows = store.getProjectDb().prepare('SELECT payload FROM project_owner_management_messages WHERE project_id=?').all(projectId) as Array<{ payload: string }>
  return rows.map(row => (JSON.parse(row.payload) as { content: string }).content).join('\n')
}

/**
 * P4 穷举：失败说明里的“核对账单”建议必须与真实请求事实一致。
 * 组合：执行状态 × 命令状态 × 请求数 × 费用已知性，共 24 组。
 */
test('Given全部失败组合 When穷举核对说明 Then查账单建议只在确实发出过请求时出现', () => {
  const cases: Array<{ executionStatus: string; commandState: string; requestsSent: number; cost: number | null }> = []
  for (const executionStatus of ['failed', 'cancelled']) {
    for (const commandState of ['needs_reconcile', 'settled']) {
      for (const requestsSent of [0, 1]) {
        for (const cost of [null, 120]) cases.push({ executionStatus, commandState, requestsSent, cost })
      }
    }
  }
  expect(cases).toHaveLength(16)
  let checked = 0
  for (const item of cases) {
    const project = projectWithOwner()
    // 同一组合用不同 hash 隔离，避免观测去重把用例合并掉。
    management.recordOwnerManagementObservation(project.id, 1, observation({
      executionStatus: item.executionStatus, commandState: item.commandState, grantState: item.commandState,
      requestsSent: item.requestsSent, actualCostMicros: item.cost,
    }), 'task-1', `hash-${checked}`)
    const text = contents(project.id)
    const needsReconcile = item.commandState === 'needs_reconcile' || item.cost === null
    if (!needsReconcile) {
      expect({ item, billing: text.includes('服务商账单'), noCost: text.includes('没有产生模型费用') })
        .toEqual({ item, billing: false, noCost: false })
    } else if (item.requestsSent === 0) {
      // 没有发出请求就不能让用户去查账单，必须说明没有产生模型费用。
      expect({ item, billing: text.includes('服务商账单'), noCost: text.includes('没有产生模型费用') })
        .toEqual({ item, billing: false, noCost: true })
    } else {
      expect({ item, billing: text.includes('在服务商账单按模型与请求时间核对'), noCost: text.includes('没有产生模型费用') })
        .toEqual({ item, billing: true, noCost: false })
    }
    checked++
  }
  expect(checked).toBe(16)
})
