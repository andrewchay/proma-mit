/**
 * TurnDecisionService 单元测试
 */

import { describe, test, expect } from 'bun:test'
import type { Goal } from '@proma/shared'

const { preTickTurn, shouldAutoAdvanceGoal, routeLabel, nextActionableTodo } = await import('./turn-decision-service')

const baseGoal: Goal = {
  id: 'goal-1',
  title: '测试目标',
  objective: 'o',
  scope: [],
  phase: 'active',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  todos: [{ id: 'todo-1', text: '任务', class: 'agent_work', status: 'open', createdAt: Date.now(), updatedAt: Date.now() }],
  gates: [],
  evidence: [],
}

function freshGoal(): Goal {
  return JSON.parse(JSON.stringify(baseGoal)) as Goal
}

/** 依赖注入：getGoal 返回 mockGoals；shouldGoalRun 用简单规则模拟 */
function makeDeps() {
  const mockGoals = new Map<string, Goal>()
  const deps = {
    getGoal: (id: string) => mockGoals.get(id),
    shouldGoalRun: (id: string) => {
      const g = mockGoals.get(id)
      if (!g) return { shouldRun: false, reason: 'goal_not_found' }
      if (g.phase === 'completed') return { shouldRun: false, reason: 'goal_terminated' }
      if (g.gates.some((x) => x.status === 'open')) return { shouldRun: false, reason: 'waiting_user' }
      if (!g.todos.some((t) => ['open', 'claimed', 'in_progress'].includes(t.status))) return { shouldRun: false, reason: 'no_actionable_todo' }
      const q = g.quota
      if (q?.maxBudgetUsd !== undefined && (q.spentUsd ?? 0) >= q.maxBudgetUsd) return { shouldRun: false, reason: 'quota_exhausted' }
      return { shouldRun: true }
    },
  }
  return { mockGoals, deps }
}

describe('TurnDecisionService', () => {
  test('未绑定 Goal → no_goal，直接执行', () => {
    const d = preTickTurn(undefined)
    expect(d.route).toBe('no_goal')
    expect(d.shouldRun).toBe(true)
  })

  test('Goal 不存在 → 降级为无约束', () => {
    const { deps } = makeDeps()
    const d = preTickTurn('missing', undefined, deps)
    expect(d.route).toBe('no_goal')
    expect(d.shouldRun).toBe(true)
  })

  test('有待处理 gate → 等待用户', () => {
    const { mockGoals, deps } = makeDeps()
    const g = freshGoal()
    g.gates = [{ id: 'gate-1', question: '允许发布？', status: 'open', createdAt: Date.now() }]
    mockGoals.set(g.id, g)
    const d = preTickTurn(g.id, undefined, deps)
    expect(d.route).toBe('wait_user_action')
    expect(d.shouldRun).toBe(false)
  })

  test('无 todo → blocked', () => {
    const { mockGoals, deps } = makeDeps()
    const g = freshGoal()
    g.todos = []
    mockGoals.set(g.id, g)
    const d = preTickTurn(g.id, undefined, deps)
    expect(d.route).toBe('blocked')
    expect(d.shouldRun).toBe(false)
  })

  test('配额耗尽 → quota_exhausted', () => {
    const { mockGoals, deps } = makeDeps()
    const g = freshGoal()
    g.quota = { maxBudgetUsd: 1, spentUsd: 1 }
    mockGoals.set(g.id, g)
    const d = preTickTurn(g.id, undefined, deps)
    expect(d.route).toBe('quota_exhausted')
    expect(d.shouldRun).toBe(false)
  })

  test('completed → goal_terminated', () => {
    const { mockGoals, deps } = makeDeps()
    const g = freshGoal()
    g.phase = 'completed'
    mockGoals.set(g.id, g)
    const d = preTickTurn(g.id, undefined, deps)
    expect(d.route).toBe('goal_terminated')
    expect(d.shouldRun).toBe(false)
  })

  test('可推进 → ready', () => {
    const { mockGoals, deps } = makeDeps()
    const g = freshGoal()
    mockGoals.set(g.id, g)
    const d = preTickTurn(g.id, '手动发消息', deps)
    expect(d.route).toBe('ready')
    expect(d.shouldRun).toBe(true)
  })

  test('shouldAutoAdvanceGoal 复用权威判断', () => {
    const { mockGoals, deps } = makeDeps()
    const g = freshGoal()
    g.gates = [{ id: 'gate-1', question: 'q', status: 'open', createdAt: Date.now() }]
    mockGoals.set(g.id, g)
    const d = shouldAutoAdvanceGoal(g.id, deps)
    expect(d.shouldRun).toBe(false)
    expect(d.route).toBe('wait_user_action')
  })

  test('nextActionableTodo 按优先级返回', () => {
    const g = freshGoal()
    expect(nextActionableTodo(g)?.id).toBe('todo-1')
    expect(nextActionableTodo(undefined)).toBeUndefined()
  })

  test('routeLabel 提供中文标签', () => {
    expect(routeLabel('wait_user_action')).toBe('等待用户')
    expect(routeLabel('quota_exhausted')).toBe('配额耗尽')
  })
})
