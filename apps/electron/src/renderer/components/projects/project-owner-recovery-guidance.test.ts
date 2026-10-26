import { expect, test } from 'bun:test'
import type { OwnerExecutionAutonomousScheduleStatus } from '@gravitas/shared'
import { deriveOwnerRecoveryGuidance } from './project-owner-recovery-guidance'

const status = (patch: Partial<OwnerExecutionAutonomousScheduleStatus> = {}): OwnerExecutionAutonomousScheduleStatus => ({
  projectId: 'p', state: 'waiting', reservedCostMicros: 10, committedCostMicros: 5, runReservations: 1, reason: '需要人工处理', ...patch,
})

test('Given费用或运行终态需要对账 When生成Owner建议 Then明确保留unknown占额且不重试', () => {
  const guidance = deriveOwnerRecoveryGuidance(status({ state: 'needs_reconcile', nextAction: 'human_decision' }))
  expect(guidance.title).toBe('先完成费用与运行对账')
  expect(guidance.caution).toContain('不要重试')
  expect(guidance.actions.join(' ')).toContain('Provider 控制台')
  expect(guidance.actions.join(' ')).toContain('逐请求预留')
  expect(guidance.actions.join(' ')).toContain('停止升级')
})

test('Given授权级别需对账且没有当前角色 When生成建议 Then检查授权下全部未结命令', () => {
  const guidance = deriveOwnerRecoveryGuidance(status({ state: 'needs_reconcile' }))
  expect(guidance.actions.join(' ')).toContain('所有未结命令')
  expect(guidance.caution).toContain('保留占额')
})

test('Given来源变化/Reviewer阻塞/业务待验收 When生成建议 Then分别要求重核范围、人工决定或验收', () => {
  expect(deriveOwnerRecoveryGuidance(status({ state: 'stale' })).title).toContain('重新核对范围')
  expect(deriveOwnerRecoveryGuidance(status({ reviewVerdict: 'blocked', nextAction: 'human_decision' })).title).toBe('需要人工决定后再继续')
  expect(deriveOwnerRecoveryGuidance(status({ nextAction: 'await_business_acceptance' })).caution).toContain('不等于业务验收')
})

test('Given所有Owner调度状态 When生成失败收口建议 Then每个终态都有安全且明确的处理方向', () => {
  const cases: Array<[OwnerExecutionAutonomousScheduleStatus['state'], string]> = [
    ['no_grant', '没有可用授权'], ['manual', '手动执行模式'], ['paused', '不可继续派发'],
    ['needs_reconcile', '先完成费用与运行对账'], ['expired', '不可继续派发'], ['archived', '不可继续派发'],
    ['stale', '重新核对范围'], ['ready', '等待已授权命令'], ['running', '正在运行'], ['waiting', '当前没有自动执行的下一步'],
  ]
  for (const [state, title] of cases) {
    const guidance = deriveOwnerRecoveryGuidance(status({ state, nextAction: 'none' }))
    expect(guidance.title).toContain(title)
    expect(guidance.actions.length).toBeGreaterThan(0)
    expect(guidance.caution.length).toBeGreaterThan(0)
  }
})

test('Given不可派发状态同时带有人工作业建议 When生成恢复指导 Then授权终态优先且不暗示重试', () => {
  for (const state of ['paused', 'expired', 'archived'] as const) {
    const guidance = deriveOwnerRecoveryGuidance(status({ state, nextAction: 'human_decision', reviewVerdict: 'blocked' }))
    expect(guidance.title).toBe('授权不可继续派发')
    expect(guidance.caution).toContain('不会复活旧授权')
  }
})
