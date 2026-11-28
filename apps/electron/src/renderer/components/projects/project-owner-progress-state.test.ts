import { expect, test } from 'bun:test'
import type { OwnerManagementMessage } from '@gravitas/shared'
import { summarizeOwnerProjectRow } from './project-owner-progress-state'

function message(kind: OwnerManagementMessage['kind'], taskId?: string): OwnerManagementMessage {
  return { id: `m-${kind}`, eventId: `e-${kind}`, projectId: 'p', conversationId: 'c', ...(taskId ? { taskId } : {}), role: 'assistant', kind, content: '', createdAt: 1 }
}

test('Given 最新消息在等用户 When 生成项目行 Then 优先显示等待你而不是调度状态', () => {
  const summary = summarizeOwnerProjectRow([message('plan_proposal')], undefined, { state: 'running' })
  expect(summary).toMatchObject({ stage: '等待你', waitingOn: '你', needsUser: true })
  expect(summary.nextAction).toBe('方案待你审阅')
})

test('Given 预算耗尽且方案待审 When 生成项目行 Then 说明在等预算决定', () => {
  const summary = summarizeOwnerProjectRow([message('plan_proposal')], undefined, { state: 'running' }, 'exhausted')
  expect(summary.nextAction).toBe('等待项目预算决定')
  expect(summary.needsUser).toBe(true)
})

test('Given 无等待消息 When 按调度状态映射 Then 只有需要用户介入的状态才 needsUser', () => {
  const cases: Array<[string, boolean, string]> = [
    ['running', false, '进行中'],
    ['ready', false, '进行中'],
    ['paused', true, '已暂停'],
    ['needs_reconcile', true, '待核对'],
    ['stale', true, '待重新确认'],
    ['expired', true, '已过期'],
    ['archived', false, '已归档'],
    ['manual', true, '手动模式'],
    ['no_grant', false, '未开始'],
  ]
  for (const [state, needsUser, stage] of cases) {
    const summary = summarizeOwnerProjectRow([], undefined, { state })
    expect({ state, needsUser: summary.needsUser, stage: summary.stage }).toEqual({ state, needsUser, stage })
  }
})

test('Given 等待中且下一动作是人工决策 When 生成项目行 Then 等待对象是你', () => {
  const summary = summarizeOwnerProjectRow([], undefined, { state: 'waiting', reason: '等待权威依赖解除', nextAction: 'human_decision' })
  expect(summary).toMatchObject({ stage: '等待中', waitingOn: '你', needsUser: true, nextAction: '等待权威依赖解除' })
})

test('Given 后台已有待回答的新问题 When 项目尚未派工或此前已交付 Then 项目状态优先提醒回答', () => {
  for (const schedule of [{ state: 'no_grant' }, { state: 'waiting', deliveryPublished: true as const }]) {
    expect(summarizeOwnerProjectRow([], undefined, { ...schedule, waitingQuestion: {} }))
      .toEqual({ stage: '等待中', waitingOn: '你', needsUser: true, nextAction: '在 Owner 对话回答问题' })
  }
})

test('Given 等待中但下一动作不是人工决策 When 生成项目行 Then 不算需要用户处理', () => {
  const summary = summarizeOwnerProjectRow([], undefined, { state: 'waiting', reason: '技术评审通过，等待业务验收', nextAction: 'await_business_acceptance' })
  expect(summary).toMatchObject({ stage: '等待中', waitingOn: '系统核对', needsUser: false })
})

test('Given 当前授权的成果已发布 When 生成项目行 Then 显示已交付并结束系统等待', () => {
  const summary = summarizeOwnerProjectRow([], undefined, { state: 'waiting', nextAction: 'none', deliveryPublished: true })
  expect(summary).toEqual({ stage: '已交付', waitingOn: '', needsUser: false, nextAction: '在项目对话查看成果' })
})

test('Given 没有调度状态 When 生成项目行 Then 说明尚未建立授权且不打扰用户', () => {
  expect(summarizeOwnerProjectRow([], undefined, undefined)).toEqual({ stage: '未开始', waitingOn: '', nextAction: '尚未建立管理授权', needsUser: false })
})

test('Given 未知调度状态 When 生成项目行 Then 保留原因并提示打开核对', () => {
  const summary = summarizeOwnerProjectRow([], undefined, { state: 'something_new', reason: '出现了未覆盖的状态' })
  expect(summary).toMatchObject({ stage: '未知', nextAction: '出现了未覆盖的状态', needsUser: false })
})

test('Given 任务级消息 When 生成另一任务的摘要 Then 不串到当前任务', () => {
  const summary = summarizeOwnerProjectRow([message('plan_proposal', 'task-a')], 'task-b', { state: 'running' })
  expect(summary.stage).toBe('进行中')
})
