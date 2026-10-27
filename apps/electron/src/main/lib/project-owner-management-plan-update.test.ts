import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OwnerExecutionObservation } from '@gravitas/shared'
import { buildElectronMock } from './testing/electron-mock'
import { auditProjectOwnerClaims } from './project-owner-claim-audit'
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
/** 消费遗留事件，构造“没有任何后台工作”的确定状态。 */
function drainPendingEvents(projectId: string): void {
  store.getProjectDb().prepare('UPDATE project_owner_management_events SET consumed_at=? WHERE project_id=? AND consumed_at IS NULL').run(Date.now(), projectId)
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

test('Given请求未发出就失败 WhenOwner记录观察 Then不要求核对账单且说明无模型费用', () => {
  const project = projectWithOwner()
  management.recordOwnerManagementObservation(project.id, 1, observation({
    role: 'executor', executionStatus: 'failed', commandState: 'needs_reconcile', grantState: 'needs_reconcile',
    resultSummary: '', error: 'No output generated. Check the stream for errors.；流错误：Owner受控出口拒绝：价格证据与当前员工冻结来源不一致',
    actualCostMicros: null, reservedCostMicros: 66212, requestsSent: 0,
  }), 'task-1', 'hash-no-request')

  const rows = store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=?").all(project.id) as Array<{ payload: string }>
  const contents = rows.map(row => (JSON.parse(row.payload) as { content: string }).content).join('\n')
  expect(contents).toContain('失败发生在发送模型请求之前，没有产生模型费用')
  expect(contents).toContain('价格证据与当前员工冻结来源不一致')
  expect(contents).not.toContain('服务商账单')
})

test('Given请求已发出但费用未知 WhenOwner记录观察 Then要求核对用量与账单', () => {
  const project = projectWithOwner()
  management.recordOwnerManagementObservation(project.id, 1, observation({
    role: 'executor', executionStatus: 'failed', commandState: 'needs_reconcile', grantState: 'needs_reconcile',
    resultSummary: '', error: '连接中断', actualCostMicros: null, reservedCostMicros: 66212, requestsSent: 1,
  }), 'task-1', 'hash-request-unknown')

  const rows = store.getProjectDb().prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=?").all(project.id) as Array<{ payload: string }>
  const contents = rows.map(row => (JSON.parse(row.payload) as { content: string }).content).join('\n')
  expect(contents).toContain('在服务商账单按模型与请求时间核对')
  expect(contents).not.toContain('没有产生模型费用')
})

test('Given真实失败观察之后 When核对说法与事实 Then最新说明不得声称后台仍在处理', () => {
  const project = projectWithOwner()
  management.recordOwnerManagementObservation(project.id, 1, observation({
    role: 'executor', executionStatus: 'failed', commandState: 'needs_reconcile', grantState: 'needs_reconcile',
    resultSummary: '', error: '失败原因', actualCostMicros: null, reservedCostMicros: 100, requestsSent: 0,
  }), 'task-1', 'hash-claim-audit')

  drainPendingEvents(project.id)
  const report = auditProjectOwnerClaims(project.id)
  expect({ violations: report.violations.length, pendingEvents: report.facts.pendingEvents, running: report.facts.runningExecutions }).toEqual({ violations: 0, pendingEvents: 0, running: 0 })
})

test('Given没有排队事实 When写入声称内部复查的消息 Then检查必须报违规', () => {
  const project = projectWithOwner()
  management.appendOwnerManagementMessage({ projectId: project.id, eventId: 'synthetic-claim', role: 'assistant', kind: 'management_progress', content: '我正在内部复查原因，稍后会自动继续。' })

  drainPendingEvents(project.id)
  const report = auditProjectOwnerClaims(project.id)
  expect(report.violations).toHaveLength(1)
  expect(report.violations[0]!.content).toContain('内部复查')
})
