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
