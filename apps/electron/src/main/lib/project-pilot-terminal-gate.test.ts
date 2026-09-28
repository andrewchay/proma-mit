import { expect, test } from 'bun:test'
import type { SDKResultMessage } from '@gravitas/shared'
import { getPilotCompletionBlocker, getPilotSettlementBlocker } from './project-pilot-terminal-gate'

const receipt = { total_cost_usd: 0.0003, usage: { input_tokens: 10, output_tokens: 5 } } as SDKResultMessage

test('Given Pi Pilot 有命令关联 When Runtime 回调正常完成 Then 不得报告成功', () => {
  expect(getPilotCompletionBlocker('pilot-command', 'pi', 'pi', receipt)).toContain('终态费用证据')
})

test('Given Pilot 来源或费用缺失 When Runtime 回调完成 Then 失败停等', () => {
  expect(getPilotCompletionBlocker('pilot-command', 'pi', 'unknown', receipt)).toContain('来源')
  expect(getPilotCompletionBlocker('pilot-command', undefined, 'proma', receipt)).toContain('来源')
  expect(getPilotCompletionBlocker('pilot-command', 'proma', 'proma')).toContain('费用结果')
  expect(getPilotCompletionBlocker('pilot-command', 'proma', 'proma', {
    ...receipt, total_cost_usd: undefined,
  } as SDKResultMessage)).toContain('费用结果')
  expect(getPilotCompletionBlocker('pilot-command', 'proma', 'proma', {
    ...receipt, usage: { input_tokens: 10 },
  } as SDKResultMessage)).toContain('费用结果')
})

test('Given Pilot 费用结算失败、待对账或归属不符 When 员工回写 Then 不得报告完成', () => {
  const settled = { commandId: 'pilot-command', state: 'settled' as const, actualCostMicros: 300, grantPaused: false }
  expect(getPilotSettlementBlocker('pilot-command', null)).toContain('未完成可归属结算')
  expect(getPilotSettlementBlocker('pilot-command', { ...settled, commandId: 'other' })).toContain('未完成可归属结算')
  expect(getPilotSettlementBlocker('pilot-command', { ...settled, state: 'needs_reconcile' })).toContain('未完成可归属结算')
  expect(getPilotSettlementBlocker('pilot-command', { ...settled, grantPaused: true })).toContain('未完成可归属结算')
  expect(getPilotSettlementBlocker('pilot-command', settled)).toBeUndefined()
  expect(getPilotSettlementBlocker(undefined, null)).toBeUndefined()
})

test('Given 普通员工或既有 Pilot Runtime 有费用结果 When 回调完成 Then 保留既有完成语义', () => {
  expect(getPilotCompletionBlocker(undefined, 'pi', 'pi')).toBeUndefined()
  expect(getPilotCompletionBlocker('pilot-command', 'proma', 'proma', receipt)).toBeUndefined()
  expect(getPilotCompletionBlocker('pilot-command', 'ai-sdk', 'ai-sdk', receipt)).toBeUndefined()
})
