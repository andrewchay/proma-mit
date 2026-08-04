/**
 * Goal 服务单元测试
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const originalHomedir = homedir()
const tempHomeDir = mkdtempSync(join(tmpdir(), 'proma-goal-test-'))

mock.module('os', () => ({
  homedir: () => tempHomeDir,
  tmpdir,
}))

// 顶部不 mock agent-session-manager；bind 测试用注入的会话依赖（避免加载 electron）

/** 生成兼容 AgentSessionMeta 的测试会话 */
function makeTestSession(id: string, title: string) {
  return { id, title, goalId: undefined as string | undefined, createdAt: Date.now(), updatedAt: Date.now() }
}

const { createGoal, getGoal, listGoals, updateGoal, deleteGoal, upsertGoalTodo, updateGoalTodoStatus, addGoalGate, resolveGoalGate, appendGoalEvidence, shouldGoalRun, canGoalSpend, spendGoalBudget, bindSessionToGoal, unbindSessionGoal, getSessionGoal, listGoalSessions } = await import('./goal-service')

describe('Goal 服务', () => {
  let configDir: string

  beforeEach(() => {
    configDir = join(tempHomeDir, `config-${Date.now()}`)
    mkdirSync(configDir, { recursive: true })
    process.env.PROMA_TEST_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true })
    delete process.env.PROMA_TEST_CONFIG_DIR
  })

  afterAll(() => {
    if (existsSync(tempHomeDir)) rmSync(tempHomeDir, { recursive: true, force: true })
    mock.module('os', () => ({
      homedir: () => originalHomedir,
      tmpdir,
    }))
  })

  test('创建 Goal 并设置默认草稿阶段', () => {
    const goal = createGoal({ title: '实现 Token 统计', objective: '按工具/Skill/MCP 统计 token' })
    expect(goal.title).toBe('实现 Token 统计')
    expect(goal.phase).toBe('draft')
    expect(goal.todos).toEqual([])
    expect(goal.gates).toEqual([])
    expect(goal.evidence).toEqual([])
    expect(getGoal(goal.id)?.id).toBe(goal.id)
  })

  test('列表查询支持按阶段和工作区过滤', () => {
    const g1 = createGoal({ title: 'A', objective: 'o1', workspaceId: 'ws-1' })
    const g2 = createGoal({ title: 'B', objective: 'o2', workspaceId: 'ws-2' })

    expect(listGoals({ workspaceId: 'ws-1' }).map((g) => g.id)).toEqual([g1.id])
    expect(listGoals({ workspaceId: 'ws-2' }).map((g) => g.id)).toEqual([g2.id])
    expect(listGoals({}).length).toBe(2)
  })

  test('更新 Goal 字段并推导阶段', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    // 添加 todo 后应变为 active
    goal = upsertGoalTodo(goal.id, { text: '第一步' })
    expect(goal.phase).toBe('active')
    expect(goal.todos.length).toBe(1)

    // 全部完成 → blocked（无活跃 todo 也无 gate）
    const todoId = goal.todos[0]!.id
    goal = updateGoalTodoStatus(goal.id, todoId, 'done')
    expect(goal.phase).toBe('blocked')

    // 更新字段
    goal = updateGoal(goal.id, { title: '更新标题' })
    expect(goal.title).toBe('更新标题')
  })

  test('添加并解决用户门控，phase 正确迁移到 waiting_user 再回退', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    goal = addGoalGate(goal.id, '是否允许执行生产发布？')
    expect(goal.gates.length).toBe(1)
    expect(goal.phase).toBe('waiting_user')

    const gateId = goal.gates[0]!.id
    goal = resolveGoalGate(goal.id, gateId, '用户已确认')
    expect(goal.gates[0]?.status).toBe('resolved')
    expect(goal.gates[0]?.resolution).toBe('用户已确认')
    // 无 todo → blocked
    expect(goal.phase).toBe('blocked')
  })

  test('追加证据并限制条数', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    goal = appendGoalEvidence(goal.id, '改动了 3 个文件')
    goal = appendGoalEvidence(goal.id, '通过了测试')
    expect(goal.evidence.length).toBe(2)
    expect(goal.evidence[1]).toContain('通过了测试')
  })

  test('领取 todo 状态流转', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    goal = upsertGoalTodo(goal.id, { text: '任务', claimedBy: 'session-1' })
    const todoId = goal.todos[0]!.id
    expect(goal.todos[0]?.claimedBy).toBe('session-1')

    goal = updateGoalTodoStatus(goal.id, todoId, 'in_progress')
    expect(goal.todos[0]?.status).toBe('in_progress')
    expect(goal.todos[0]?.claimedBy).toBe('session-1')

    goal = updateGoalTodoStatus(goal.id, todoId, 'done')
    expect(goal.todos[0]?.status).toBe('done')
    // 完成后清除 claim
    expect(goal.todos[0]?.claimedBy).toBeUndefined()
  })

  test('删除 Goal', () => {
    const goal = createGoal({ title: 'A', objective: 'o' })
    deleteGoal(goal.id)
    expect(getGoal(goal.id)).toBeUndefined()
  })

  test('完成/归档阶段不自动推导覆盖', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    goal = updateGoal(goal.id, { phase: 'completed' })
    // 即使加 todo 也不覆盖 completed
    goal = upsertGoalTodo(goal.id, { text: '迟到任务' })
    expect(goal.phase).toBe('completed')
  })

  test('should-run：有 todo 且无 gate 时允许推进', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    goal = upsertGoalTodo(goal.id, { text: '任务' })
    expect(shouldGoalRun(goal.id)).toEqual({ shouldRun: true })
  })

  test('should-run：有待处理 gate 时等待用户', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    goal = upsertGoalTodo(goal.id, { text: '任务' })
    goal = addGoalGate(goal.id, '是否允许执行？')
    const res = shouldGoalRun(goal.id)
    expect(res.shouldRun).toBe(false)
    expect(res.reason).toBe('waiting_user')
  })

  test('should-run：无 todo 时不推进', () => {
    const goal = createGoal({ title: 'A', objective: 'o' })
    const res = shouldGoalRun(goal.id)
    expect(res.shouldRun).toBe(false)
    expect(res.reason).toBe('no_actionable_todo')
  })

  test('配额：超限后 can-spend / should-run 返回 false', () => {
    let goal = createGoal({ title: 'A', objective: 'o' })
    goal = upsertGoalTodo(goal.id, { text: '任务' })
    goal = updateGoal(goal.id, { quota: { maxBudgetUsd: 1, spentUsd: 0 } })

    // 未超过配额
    expect(canGoalSpend(goal.id, 0.5).allowed).toBe(true)
    expect(shouldGoalRun(goal.id).shouldRun).toBe(true)

    // 花费 0.8（累计 0.8），再请求 0.5 → 超限
    spendGoalBudget(goal.id, 0.8)
    expect(canGoalSpend(goal.id, 0.5).allowed).toBe(false)
    expect(canGoalSpend(goal.id, 0.2).allowed).toBe(true)

    // 累计 1.0 耗尽 → should-run 停止
    spendGoalBudget(goal.id, 0.2)
    const res = shouldGoalRun(goal.id)
    expect(res.shouldRun).toBe(false)
    expect(res.reason).toBe('quota_exhausted')
  })

  test('A2: 绑定会话到 Goal，绑定后证据沉淀且可查询', () => {
    const goal = createGoal({ title: 'A', objective: 'o' })
    const store = new Map<string, ReturnType<typeof makeTestSession>>()
    const deps = {
      getAgentSessionMeta: (id: string) => store.get(id),
      updateAgentSessionMeta: (id: string, updates: Record<string, string | undefined>) => {
        const existing = store.get(id) ?? makeTestSession(id, '会话语')
        store.set(id, { ...existing, ...(updates.goalId !== undefined ? { goalId: updates.goalId } : { goalId: undefined }) })
        return existing
      },
      listAgentSessions: () => [...store.values()],
    }
    store.set('session-1', makeTestSession('session-1', '会话语'))

    const bound = bindSessionToGoal('session-1', goal.id, deps)
    expect(bound.goalId).toBe(goal.id)
    expect(getGoal(goal.id)?.evidence.some((e) => e.includes('绑定会话'))).toBe(true)
    expect(getSessionGoal('session-1', deps)?.id).toBe(goal.id)
    expect(listGoalSessions(goal.id, deps).some((s) => s.sessionId === 'session-1')).toBe(true)
  })

  test('A2: 解绑会话清除 goalId，goal 不再关联', () => {
    const goal = createGoal({ title: 'A', objective: 'o' })
    const store = new Map<string, ReturnType<typeof makeTestSession>>()
    const deps = {
      getAgentSessionMeta: (id: string) => store.get(id),
      updateAgentSessionMeta: (id: string, updates: Record<string, string | undefined>) => {
        const existing = store.get(id) ?? makeTestSession(id, '会话语')
        store.set(id, { ...existing, ...(updates.goalId !== undefined ? { goalId: updates.goalId } : { goalId: undefined }) })
        return existing
      },
      listAgentSessions: () => [...store.values()],
    }
    store.set('session-1', makeTestSession('session-1', '会话语'))
    bindSessionToGoal('session-1', goal.id, deps)

    unbindSessionGoal('session-1', deps)
    expect(getSessionGoal('session-1', deps)).toBeUndefined()
    expect(listGoalSessions(goal.id, deps).length).toBe(0)
  })

  test('A2: 绑定到不存在的 Goal 时报错', () => {
    const store = new Map<string, ReturnType<typeof makeTestSession>>()
    const deps = {
      getAgentSessionMeta: (id: string) => store.get(id),
      updateAgentSessionMeta: (id: string, updates: Record<string, string | undefined>) => store.get(id) ?? makeTestSession(id, 'x'),
      listAgentSessions: () => [...store.values()],
    }
    store.set('session-1', makeTestSession('session-1', 'x'))
    expect(() => bindSessionToGoal('session-1', 'missing', deps)).toThrow(/Goal 不存在/)
  })
})
