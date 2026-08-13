import { describe, expect, it } from 'bun:test'
import type { ExecutionContract } from './execution-contract'
import { isExecutionContractTerminal, normalizeSourceLabel } from './execution-contract'

describe('execution-contract 类型与工具', () => {
  it('isExecutionContractTerminal 正确判定终态', () => {
    expect(isExecutionContractTerminal('completed')).toBe(true)
    expect(isExecutionContractTerminal('failed')).toBe(true)
    expect(isExecutionContractTerminal('cancelled')).toBe(true)
    expect(isExecutionContractTerminal('stale')).toBe(true)
    expect(isExecutionContractTerminal('queued')).toBe(false)
    expect(isExecutionContractTerminal('running')).toBe(false)
  })

  it('normalizeSourceLabel 解析 task:xxx 前缀', () => {
    expect(normalizeSourceLabel('task')).toBe('项目管理任务')
    expect(normalizeSourceLabel('schedule')).toBe('定时触发')
    expect(normalizeSourceLabel('event')).toBe('事件触发')
    expect(normalizeSourceLabel('unknown-src')).toBe('unknown-src')
  })

  it('ExecutionContract 泛型可承载任务payload与结果', () => {
    const contract: ExecutionContract<{ taskId: string }, { summary: string }> = {
      contractId: 'c1',
      agentId: 'emp-1',
      source: 'task',
      sourceId: 't1',
      executor: 'headless',
      status: 'completed',
      payload: { taskId: 't1' },
      result: { summary: '完成' },
      createdAt: 1,
      startedAt: 2,
      completedAt: 3,
    }
    expect(contract.result?.summary).toBe('完成')
    expect(contract.status).toBe('completed')
  })
})
