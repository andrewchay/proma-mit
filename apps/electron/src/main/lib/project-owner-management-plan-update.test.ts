import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnerExecutionObservation } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-plan-update-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
const management = await import('./project-owner-management-store')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
await store.initProjectDb()
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

/** 只建目标与管理主体；本用例不派工、不调用模型。 */
function projectWithOwner() {
  const project = store.createProject({ title: '方案更新夹具', description: '' })
  const draft = saveProjectOwnerGoalDraft(project.id, 0, { objective: '交付一份可核验的说明' })
  management.recordOwnerManagementGoal(draft)
  return project
}
function observation(overrides: Partial<OwnerExecutionObservation> = {}): OwnerExecutionObservation {
  return {
    executionId: 'execution-1', commandId: 'command-1', grantId: 'grant-1', sourcePlanRevision: 2,
    businessTaskId: 'task-1', taskTitle: '研究材料', role: 'reviewer', trigger: 'terminal',
    executionStatus: 'completed', commandState: 'settled', grantState: 'active',
    completedAt: 1, resultSummary: '合成评审', error: '', actualCostMicros: 120, reservedCostMicros: 500,
    ...overrides,
  }
}
function planUpdateMessages(projectId: string): string[] {
  const rows = store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=?").all(projectId) as Array<{ payload: string }>
  return rows.map(row => JSON.parse(row.payload) as { eventId: string; content: string })
    .filter(message => message.eventId.includes(':plan-update'))
    .map(message => message.content)
}

test('Given独立检查要求修改 WhenOwner记录观察 Then主动给出发现影响建议且重复观察不重复播报', () => {
  const project = projectWithOwner()
  const review = { verdict: 'changes_requested', summary: '引用不完整', findings: ['第3页数字缺少页码依据', '未标注未知项', '结论超出资料范围', '缺少运行步骤', '第五项'] }
  const hash = 'hash-changes-requested'
  management.recordOwnerManagementObservation(project.id, 1, observation({ review }), 'task-1', hash)
  management.recordOwnerManagementObservation(project.id, 1, observation({ review }), 'task-1', hash)

  const messages = planUpdateMessages(project.id)
  expect(messages).toHaveLength(1)
  const [content] = messages
  expect(content).toContain('发现：独立检查未通过（引用不完整），提出 5 项修改')
  expect(content).toContain('第3页数字缺少页码依据')
  expect(content).toContain('另有 2 项')
  expect(content).toContain('影响：本轮成果已保留但不能作为交付')
  expect(content).toContain('建议：先按上述修改点调整执行内容和验收依据')
  expect(content).toContain('超出已确认的目标、资料或费用边界')
})

test('Given独立检查通过 WhenOwner记录观察 Then说明可进入交付且不要求追加授权', () => {
  const project = projectWithOwner()
  management.recordOwnerManagementObservation(project.id, 1, observation({
    review: { verdict: 'approved', summary: '逐条核对通过', findings: ['建议补充图表标注'] },
  }), 'task-1', 'hash-approved')

  const messages = planUpdateMessages(project.id)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('发现：独立检查通过（逐条核对通过）')
  expect(messages[0]).toContain('仍记录 1 项非阻断项')
  expect(messages[0]).toContain('影响：成果可以进入交付，不需要为此改动方案或追加授权')
  expect(messages[0]).toContain('建议：我继续整理交付说明')
})

test('Given检查结论不是通过或不通过 WhenOwner记录观察 Then按事实说明且不自动返工', () => {
  const project = projectWithOwner()
  management.recordOwnerManagementObservation(project.id, 1, observation({
    review: { verdict: 'blocked', summary: '资料不足以核验', findings: [] },
  }), 'task-1', 'hash-blocked')

  const messages = planUpdateMessages(project.id)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('发现：独立检查结论为 blocked（资料不足以核验）')
  expect(messages[0]).toContain('影响：结论不是通过，本轮不能按已通过处理')
  expect(messages[0]).toContain('建议：先核对检查依据与本轮成果')
})

test('Given检查已返回但没有评审证据 WhenOwner记录观察 Then退回通用进展而不补造建议', () => {
  const project = projectWithOwner()
  management.recordOwnerManagementObservation(project.id, 1, observation({ review: undefined }), 'task-1', 'hash-no-review')

  expect(planUpdateMessages(project.id)).toHaveLength(0)
  const rows = store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=?").all(project.id) as Array<{ payload: string }>
  const contents = rows.map(row => (JSON.parse(row.payload) as { content: string }).content)
  expect(contents).toContain('独立检查已返回。我正在结合成果、检查结论和验收标准整理下一步。')
})
