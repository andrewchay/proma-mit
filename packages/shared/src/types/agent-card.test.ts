import { describe, expect, it } from 'bun:test'
import type { AgentEmployeeResult } from './work-module'
import { AGENT_CARD_SOURCE_EMPLOYEE, buildAgentCardFromEmployee } from './agent-card'

function makeEmployee(overrides: Partial<AgentEmployeeResult> = {}): AgentEmployeeResult {
  return {
    id: 'emp-1',
    name: '小王',
    role: '内容运营',
    description: '负责内容产出',
    runtime: 'proma',
    channelId: 'ch1',
    modelId: 'm1',
    skills: ['docx'],
    enabled: true,
    totalTasks: 3,
    completedTasks: 2,
    avgDurationMs: 12000,
    failureCount: 1,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('agent-card', () => {
  it('从 AI 员工档案构建 Agent Card（无 workflowId）', () => {
    const card = buildAgentCardFromEmployee(makeEmployee())

    expect(card.cardId).toBe('emp-1')
    expect(card.source).toBe(AGENT_CARD_SOURCE_EMPLOYEE)
    expect(card.employeeId).toBe('emp-1')
    expect(card.name).toBe('小王')
    expect(card.role).toBe('内容运营')
    expect(card.description).toBe('负责内容产出')
    expect(card.capabilities).toEqual(['docx'])
    expect(card.fixedWorkflowId).toBeUndefined()
    expect(card.executionStats).toEqual({
      totalRuns: 3,
      completedRuns: 2,
      avgDurationMs: 12000,
      failureCount: 1,
    })
    expect(card.enabled).toBe(true)
    expect(card.createdAt).toBe(1000)
    expect(card.updatedAt).toBe(1000)
  })

  it('workflowId 存在时映射为 fixedWorkflowId', () => {
    const card = buildAgentCardFromEmployee(
      makeEmployee({ id: 'emp-2', name: '小王2', role: 'SOP岗', workflowId: 'wf-9', skills: [] }),
    )

    expect(card.employeeId).toBe('emp-2')
    expect(card.fixedWorkflowId).toBe('wf-9')
    expect(card.capabilities).toEqual([])
  })

  it('缺省 executionStats 字段可接受（avgDurationMs 可选）', () => {
    const card = buildAgentCardFromEmployee(
      makeEmployee({ avgDurationMs: undefined, totalTasks: 0, completedTasks: 0, failureCount: 0 }),
    )

    expect(card.executionStats?.avgDurationMs).toBeUndefined()
    expect(card.executionStats?.totalRuns).toBe(0)
  })
})
