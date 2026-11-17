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
