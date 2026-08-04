/**
 * Goal 服务 —— 长生命周期目标状态层（P0）
 *
 * 借鉴 LoopX 思路：Goal 是持久的统一工作对象，跨会话/定时任务/工作流
 * 追踪目标、todos、gates、evidence、quota。状态权威在本地 JSON 文件。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Goal,
  GoalCreateInput,
  GoalGate,
  GoalIndex,
  GoalQuery,
  GoalTodo,
  GoalUpdateInput,
  UpsertTodoInput,
} from '@proma/shared'
import { getGoalPath, getGoalIndexPath, getGoalsDir } from './config-paths'

/** 索引内最多保留的 Goal 摘要数 */
const MAX_INDEX_GOALS = 500
/** 单个 Goal 最多保留的证据条数 */
const MAX_EVIDENCE_PER_GOAL = 200

/** 生成合法 id（带前缀，避免与随机 uuid 混淆） */
function genId(): string {
  return `goal-${randomUUID().slice(0, 8)}`
}

function now(): number {
  return Date.now()
}

/** 规范化 Goal 阶段（防止非法值） */
function normalizePhase(phase: string): Goal['phase'] {
  const allowed: Goal['phase'][] = ['draft', 'active', 'waiting_user', 'blocked', 'completed', 'archived']
  return allowed.includes(phase as Goal['phase']) ? (phase as Goal['phase']) : 'draft'
}

function normalizeTodoClass(cls: string): GoalTodo['class'] {
  const allowed: GoalTodo['class'][] = ['user_gate', 'agent_work', 'monitor', 'checkpoint']
  return allowed.includes(cls as GoalTodo['class']) ? (cls as GoalTodo['class']) : 'agent_work'
}

function normalizeTodoStatus(status: string): GoalTodo['status'] {
  const allowed: GoalTodo['status'][] = ['open', 'claimed', 'in_progress', 'blocked', 'done', 'deferred']
  return allowed.includes(status as GoalTodo['status']) ? (status as GoalTodo['status']) : 'open'
}

/** 读取单个 Goal 文件 */
function readGoal(id: string): Goal | undefined {
  const path = getGoalPath(id)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Goal
  } catch {
    return undefined
  }
}

/** 写单个 Goal 文件 */
function writeGoal(goal: Goal): void {
  const path = getGoalPath(goal.id)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(goal, null, 2), 'utf-8')
}

/** 根据 Goal 内容推导 phase（内部一致性维护） */
function derivePhase(goal: Goal): void {
  if (goal.phase === 'completed' || goal.phase === 'archived') return
  const hasOpenGate = goal.gates.some((g) => g.status === 'open')
  const hasActiveTodo = goal.todos.some((t) => !['done', 'deferred'].includes(t.status))
  if (hasOpenGate) {
    goal.phase = 'waiting_user'
  } else if (hasActiveTodo) {
    goal.phase = 'active'
  } else {
    goal.phase = 'blocked'
  }
}

/** 重建 Goal 索引 */
function rebuildIndex(): void {
  try {
    const dir = getGoalsDir()
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
    const goals: GoalIndex['goals'] = []
    for (const file of files) {
      const id = file.slice(0, -'.json'.length)
      const goal = readGoal(id)
      if (!goal) continue
      goals.push({
        id: goal.id,
        title: goal.title,
        phase: goal.phase,
        workspaceId: goal.workspaceId,
        updatedAt: goal.updatedAt,
        openTodos: goal.todos.filter((t) => !['done', 'deferred'].includes(t.status)).length,
        openGates: goal.gates.filter((g) => g.status === 'open').length,
      })
    }
    goals.sort((a, b) => b.updatedAt - a.updatedAt)
    const index: GoalIndex = { version: 1, goals: goals.slice(0, MAX_INDEX_GOALS), lastUpdatedAt: now() }
    writeFileSync(getGoalIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
  } catch (error) {
    console.error('[Goal] 重建索引失败:', error)
  }
}

// ===== CRUD =====

export function createGoal(input: GoalCreateInput): Goal {
  const goal: Goal = {
    id: genId(),
    title: input.title.trim(),
    objective: input.objective.trim(),
    scope: input.scope ?? [],
    phase: 'draft',
    workspaceId: input.workspaceId,
    authoritySource: input.authoritySource,
    createdAt: now(),
    updatedAt: now(),
    todos: [],
    gates: [],
    evidence: [],
    quota: undefined,
  }
  writeGoal(goal)
  rebuildIndex()
  return goal
}

export function getGoal(id: string): Goal | undefined {
  return readGoal(id)
}

export function listGoals(query: GoalQuery = {}): Goal[] {
  const dir = getGoalsDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  const goals: Goal[] = []
  for (const file of files) {
    const id = file.slice(0, -'.json'.length)
    const goal = readGoal(id)
    if (!goal) continue
    if (query.phase && goal.phase !== query.phase) continue
    if (query.workspaceId && goal.workspaceId !== query.workspaceId) continue
    goals.push(goal)
  }
  goals.sort((a, b) => b.updatedAt - a.updatedAt)
  return goals
}

export function updateGoal(id: string, input: GoalUpdateInput): Goal {
  const goal = readGoal(id)
  if (!goal) throw new Error(`Goal 不存在: ${id}`)
  if (input.title !== undefined) goal.title = input.title.trim()
  if (input.objective !== undefined) goal.objective = input.objective.trim()
  if (input.scope !== undefined) goal.scope = input.scope
  if (input.phase !== undefined) goal.phase = normalizePhase(input.phase)
  if (input.quota !== undefined) goal.quota = input.quota
  goal.updatedAt = now()
  derivePhase(goal)
  writeGoal(goal)
  rebuildIndex()
  return goal
}

export function deleteGoal(id: string): void {
  const path = getGoalPath(id)
  if (existsSync(path)) rmSync(path)
  rebuildIndex()
}

// ===== Todo 操作 =====

export function upsertGoalTodo(goalId: string, input: UpsertTodoInput): Goal {
  const goal = readGoal(goalId)
  if (!goal) throw new Error(`Goal 不存在: ${goalId}`)

  if (input.id) {
    // 更新已存在 todo
    const todo = goal.todos.find((t) => t.id === input.id)
    if (todo) {
      todo.text = input.text.trim() || todo.text
      if (input.class !== undefined) todo.class = normalizeTodoClass(input.class)
      if (input.claimedBy !== undefined) todo.claimedBy = input.claimedBy
      if (input.unblocksTodoId !== undefined) todo.unblocksTodoId = input.unblocksTodoId
      todo.updatedAt = now()
    } else {
      const newTodo = buildTodo(input, goalId)
      goal.todos.push(newTodo)
    }
  } else {
    goal.todos.push(buildTodo(input, goalId))
  }

  goal.updatedAt = now()
  derivePhase(goal)
  writeGoal(goal)
  rebuildIndex()
  return goal
}

function buildTodo(input: UpsertTodoInput, _goalId: string): GoalTodo {
  return {
    id: `todo-${randomUUID().slice(0, 8)}`,
    text: input.text.trim(),
    class: input.class ? normalizeTodoClass(input.class) : 'agent_work',
    status: 'open',
    claimedBy: input.claimedBy,
    unblocksTodoId: input.unblocksTodoId,
    createdAt: now(),
    updatedAt: now(),
  }
}

export function updateGoalTodoStatus(goalId: string, todoId: string, status: GoalTodo['status']): Goal {
  const goal = readGoal(goalId)
  if (!goal) throw new Error(`Goal 不存在: ${goalId}`)
  const todo = goal.todos.find((t) => t.id === todoId)
  if (!todo) throw new Error(`Todo 不存在: ${todoId}`)
  todo.status = normalizeTodoStatus(status)
  todo.updatedAt = now()
  if (status === 'done' || status === 'deferred') {
    todo.claimedBy = undefined
  }
  goal.updatedAt = now()
  derivePhase(goal)
  writeGoal(goal)
  rebuildIndex()
  return goal
}

// ===== Gate 操作 =====

export function addGoalGate(goalId: string, question: string): Goal {
  const goal = readGoal(goalId)
  if (!goal) throw new Error(`Goal 不存在: ${goalId}`)
  const gate: GoalGate = {
    id: `gate-${randomUUID().slice(0, 8)}`,
    question: question.trim(),
    status: 'open',
    createdAt: now(),
  }
  goal.gates.push(gate)
  goal.updatedAt = now()
  derivePhase(goal)
  writeGoal(goal)
  rebuildIndex()
  return goal
}

export function resolveGoalGate(goalId: string, gateId: string, resolution: string): Goal {
  const goal = readGoal(goalId)
  if (!goal) throw new Error(`Goal 不存在: ${goalId}`)
  const gate = goal.gates.find((g) => g.id === gateId)
  if (!gate) throw new Error(`Gate 不存在: ${gateId}`)
  gate.status = 'resolved'
  gate.resolution = resolution.trim()
  gate.resolvedAt = now()
  goal.updatedAt = now()
  derivePhase(goal)
  writeGoal(goal)
  rebuildIndex()
  return goal
}

// ===== Evidence 操作 =====

export function appendGoalEvidence(goalId: string, evidence: string): Goal {
  const goal = readGoal(goalId)
  if (!goal) throw new Error(`Goal 不存在: ${goalId}`)
  goal.evidence.push(`[${new Date().toISOString()}] ${evidence.trim()}`)
  if (goal.evidence.length > MAX_EVIDENCE_PER_GOAL) {
    goal.evidence = goal.evidence.slice(-MAX_EVIDENCE_PER_GOAL)
  }
  goal.updatedAt = now()
  writeGoal(goal)
  rebuildIndex()
  return goal
}

/** 全局单例入口标识（非真实单例，提供导入便利） */
export const goalService = {
  create: createGoal,
  get: getGoal,
  list: listGoals,
  update: updateGoal,
  delete: deleteGoal,
  upsertTodo: upsertGoalTodo,
  updateTodoStatus: updateGoalTodoStatus,
  addGate: addGoalGate,
  resolveGate: resolveGoalGate,
  appendEvidence: appendGoalEvidence,
  shouldRun: shouldGoalRun,
  spendBudget: spendGoalBudget,
  canSpend: canGoalSpend,
}

// ===== 配额（P1） =====

/**
 * 判断某个 Goal 当前是否应推进（should-run）
 *
 * 返回 false 的场景：
 * - 未设置配额时默认可得；
 * - 有未解决的用户门控（等待用户，不自动执行）；
 * - 没有需要执行的 open todo（无工作可推进）；
 * - 配额已耗尽。
 */
export function shouldGoalRun(goalId: string): { shouldRun: boolean; reason?: string } {
  const goal = readGoal(goalId)
  if (!goal) return { shouldRun: false, reason: 'goal_not_found' }

  // 已完成/已归档不再推进
  if (goal.phase === 'completed' || goal.phase === 'archived') {
    return { shouldRun: false, reason: 'goal_terminated' }
  }

  // 有未解决的用户门控 → 等待用户，不自动执行
  const openGate = goal.gates.some((g) => g.status === 'open')
  if (openGate) {
    return { shouldRun: false, reason: 'waiting_user' }
  }

  // 没有需要执行的 todo
  const hasActionableTodo = goal.todos.some((t) => ['open', 'claimed', 'in_progress'].includes(t.status))
  if (!hasActionableTodo) {
    return { shouldRun: false, reason: 'no_actionable_todo' }
  }

  // 配额检查
  const quota = goal.quota
  if (quota?.maxBudgetUsd && (quota.spentUsd ?? 0) >= quota.maxBudgetUsd) {
    return { shouldRun: false, reason: 'quota_exhausted' }
  }

  return { shouldRun: true }
}

/**
 * 检查 Goal 是否允许花费（配额足够）
 */
export function canGoalSpend(goalId: string, usd: number): { allowed: boolean; reason?: string } {
  const goal = readGoal(goalId)
  if (!goal) return { allowed: false, reason: 'goal_not_found' }
  const quota = goal.quota
  if (!quota?.maxBudgetUsd) return { allowed: true } // 未设置配额 → 不限制
  const spent = quota.spentUsd ?? 0
  if (spent + usd > quota.maxBudgetUsd) {
    return { allowed: false, reason: 'quota_exhausted' }
  }
  return { allowed: true, reason: 'quota_available' }
}

/**
 * 记录 Goal 已花费（spend-budget）
 */
export function spendGoalBudget(goalId: string, usd: number): Goal {
  const goal = readGoal(goalId)
  if (!goal) throw new Error(`Goal 不存在: ${goalId}`)
  if (usd <= 0) return goal
  goal.quota = {
    maxBudgetUsd: goal.quota?.maxBudgetUsd,
    spentUsd: (goal.quota?.spentUsd ?? 0) + usd,
  }
  goal.updatedAt = now()
  writeGoal(goal)
  rebuildIndex()
  return goal
}
