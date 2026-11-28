import { expect, test } from 'bun:test'
import { deriveOwnerExecutionAttention } from './project-owner-execution-attention'

test('Given授权暂停且有失败命令 When推导 Then给出阻塞原因与可用操作', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'paused', scheduleState: null, nextAction: null,
    commands: [{ state: 'settled', executionStatus: 'failed', taskTitle: '实现页面', terminalEvidence: { reason: 'provider_stop' } }],
    completed: false,
  })
  expect(state).toMatchObject({ blocked: true, title: '研发执行未完成，需要核对' })
  expect(state?.actions.join()).toContain('查看失败证据')
})

test('Given输出上限失败 When推导 Then标题区分原因', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'active', scheduleState: null, nextAction: null,
    commands: [{ state: 'settled', executionStatus: 'failed', taskTitle: '实现页面', terminalEvidence: { reason: 'output_limit' } }],
    completed: false,
  })
  expect(state?.title).toBe('研发执行达到输出上限，需要核对')
})

test('Given一切正常 When推导 Then没有阻塞', () => {
  expect(deriveOwnerExecutionAttention({ grantState: 'active', scheduleState: 'running', nextAction: null, commands: [], completed: false })).toBeNull()
})

test('Given已交付 When推导 Then即使授权暂停也不报告阻塞', () => {
  expect(deriveOwnerExecutionAttention({ grantState: 'paused', scheduleState: null, nextAction: null, commands: [], completed: true })).toBeNull()
})

test('Given调度过期 When推导 Then报告授权暂停而非研发失败', () => {
  const state = deriveOwnerExecutionAttention({ grantState: 'active', scheduleState: 'expired', nextAction: null, commands: [], completed: false })
  expect(state?.title).toBe('执行授权暂停，需要核对')
})

test('Given失败命令有executionId When推导 Then提供重新核对入口', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'paused', scheduleState: null, nextAction: null,
    commands: [{ state: 'settled', executionStatus: 'failed', taskTitle: '实现页面', executionId: 'exec-9', terminalEvidence: { reason: 'provider_stop' } }],
    completed: false,
  })
  expect(state?.recheckExecutionId).toBe('exec-9')
})

test('Given失败命令没有executionId When推导 Then不提供重新核对入口', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'paused', scheduleState: null, nextAction: null,
    commands: [{ state: 'settled', executionStatus: 'failed', taskTitle: '实现页面', executionId: null, terminalEvidence: { reason: 'provider_stop' } }],
    completed: false,
  })
  expect(state?.recheckExecutionId).toBeUndefined()
})

// 真实状态转换：认领前准备失败（如研发工作区被占）会把**命令**单独写成 needs_reconcile，
// 而授权仍是 active、调度也还没进入 needs_reconcile。共享推导漏了这一层，
// 于是对话区说「暂无待你决定的事项」，执行区却在等用户处理。
test('Given只有命令级needs_reconcile When推导 Then仍然报告阻塞', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'active', scheduleState: 'ready', nextAction: null,
    commands: [{ state: 'needs_reconcile', executionStatus: null, taskTitle: '实现页面', executionId: 'exec-7' }],
    completed: false,
  })
  expect(state).toMatchObject({ blocked: true })
  expect(state?.detail).toContain('实现页面')
  expect(state?.recheckExecutionId).toBe('exec-7')
})

test('Given命令终态未知 When推导 Then报告需要核对而不是当作已结束', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'active', scheduleState: null, nextAction: null,
    commands: [{ state: 'unknown', executionStatus: null, taskTitle: '实现页面' }],
    completed: false,
  })
  expect(state?.blocked).toBe(true)
})

test('Given 旧版已恢复命令排队但授权待对账 When 有明确工作区阻塞证据 Then 显示原执行的核对入口', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'needs_reconcile', scheduleState: 'needs_reconcile', nextAction: null, completed: false,
    currentSchedule: { grantId: 'current' },
    commands: [
      { grantId: 'older', state: 'needs_reconcile', executionStatus: 'queued', taskTitle: '旧任务', executionId: 'old', workspaceBlocked: true },
      { grantId: 'current', state: 'queued', executionStatus: 'queued', taskTitle: '页面集成', executionId: 'page', workspaceBlocked: true },
    ],
  })
  expect(state).toMatchObject({ title: '研发工作区需要清理', recheckExecutionId: 'page' })
})

test('Given命令失败但状态未结算 When推导 Then同样报告阻塞', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'active', scheduleState: null, nextAction: null,
    commands: [{ state: 'failed', executionStatus: 'failed', taskTitle: '实现页面' }],
    completed: false,
  })
  expect(state?.blocked).toBe(true)
})

// released / cancelled 不需要用户介入：前者是被接替释放，后者是用户自己停的。
test('Given命令已释放或已取消 When推导 Then不报告阻塞', () => {
  for (const state of ['released', 'cancelled'] as const) {
    expect(deriveOwnerExecutionAttention({
      grantState: 'active', scheduleState: 'ready', nextAction: null,
      commands: [{ state, executionStatus: null, taskTitle: '实现页面' }],
      completed: false,
    })).toBeNull()
  }
})

test('Given评审运行已结算但回执被拒 When项目在等待用户决定 Then说明后续执行已暂停', () => {
  expect(deriveOwnerExecutionAttention({
    grantState: 'active', scheduleState: 'waiting', nextAction: 'human_decision', completed: false,
    currentSchedule: { role: 'reviewer', grantId: 'grant', taskId: 'task', reworkOrdinal: 0 },
    commands: [{ role: 'reviewer', grantId: 'grant', taskId: 'task', reworkOrdinal: 0, state: 'settled', executionStatus: 'completed', taskTitle: '核对计数器' }],
  })).toMatchObject({ blocked: true, title: '独立评审需要核对，后续工作已暂停' })
})

test('Given旧授权有失败且当前手册评审费用待核对 When推导 Then说明原成果仍在及当前评审阻塞', () => {
  const state = deriveOwnerExecutionAttention({
    grantState: 'needs_reconcile', scheduleState: 'needs_reconcile', nextAction: null, completed: false,
    currentSchedule: { grantId: 'current' },
    commands: [
      { grantId: 'older', role: 'executor', state: 'needs_reconcile', executionStatus: 'failed', taskTitle: '旧任务' },
      { grantId: 'current', role: 'reviewer', state: 'needs_reconcile', executionStatus: 'failed',
        taskTitle: '保存手册', executionId: 'review', terminalEvidence: { reason: 'provider_stop' } },
    ],
  })
  expect(state).toMatchObject({
    title: '独立评审未能完成',
    detail: '「保存手册」的执行成果记录已保留，独立评审尚无可用结论。本次评审费用仍需核对，原预留已保留。',
  })
  expect(state?.recheckExecutionId).toBeUndefined()
})

test('Given原评审费用待核对并已有替代评审 When推导 Then历史评审不覆盖当前状态', () => {
  const historical = { state: 'needs_reconcile', executionStatus: 'failed', role: 'reviewer', taskTitle: '保存手册', reviewReplaced: true } as const
  const activeReview = { state: 'running', executionStatus: 'running', role: 'reviewer', taskTitle: '保存手册' } as const
  expect(deriveOwnerExecutionAttention({ grantState: 'active', scheduleState: 'running', nextAction: 'review',
    commands: [historical, activeReview], completed: false })).toBeNull()
  expect(deriveOwnerExecutionAttention({ grantState: 'needs_reconcile', scheduleState: 'needs_reconcile', nextAction: 'review',
    commands: [historical, { ...activeReview, state: 'needs_reconcile', executionStatus: 'failed' }], completed: false }))
    .toMatchObject({ title: '独立评审未能完成' })
})
