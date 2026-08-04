/**
 * TurnDecisionService —— 轮次决策层（P2）
 *
 * 借鉴 LoopX 的 turn route 思想：Agent 每轮执行前先做前置路由判断，
 * 确定本轮是执行（ready）、等待用户（wait_user_action）、被阻塞（blocked）、
 * 配额耗尽（quota_exhausted）还是需要重规划（replan_required）。
 *
 * 决策不强制阻断（用户手动触发仍可执行），主要用于：给 UI 提供状态提示、
 * 给自动化/定时任务提供"是否应继续"的依据，避免盲目连续消耗。
 */

import type { Goal, GoalTodo } from '@proma/shared'
import { getGoal, shouldGoalRun } from './goal-service'
/** 轮次决策路由 */
export type TurnRoute =
  | 'ready' // 可以执行
  | 'wait_user_action' // 有待处理用户门控，等待人类
  | 'blocked' // 被阻塞（无活跃 todo / goal 不存在）
  | 'quota_exhausted' // 配额耗尽
  | 'goal_terminated' // goal 已完成/归档
  | 'replan_required' // 需要重规划（目标/范围已变化，todo 不再匹配）
  | 'repair_required' // 需要自修复（上轮失败/状态损坏）
  | 'no_goal' // 会话未绑定 Goal，无约束

/** 轮次决策结果 */
export interface TurnDecision {
  route: TurnRoute
  shouldRun: boolean
  /** 人类可读原因（中文） */
  reason?: string
  /** 关联的 Goal（若绑定） */
  goal?: Goal
}

/**
 * 会话绑定的 Goal 的前置路由决策（preTick）。
 *
 * @param goalId 会话绑定的 Goal id
 * @param userMessage 本次用户消息（手动发送时通常仍允许执行，仅提示）
 * @param deps 可注入依赖（测试用）
 * @returns TurnDecision
 */
export function preTickTurn(
  goalId: string | undefined,
  userMessage: string | undefined = undefined,
  deps: { getGoal: (id: string) => Goal | undefined } = { getGoal },
  sessionBudget?: { maxBudgetUsd: number; spentUsd: number },
): TurnDecision {
  const goalProvider = deps.getGoal
  // 未绑定 Goal：有会话级配额则按配额判断，否则无约束
  if (!goalId) {
    if (sessionBudget && sessionBudget.maxBudgetUsd > 0 && sessionBudget.spentUsd >= sessionBudget.maxBudgetUsd) {
      return {
        route: 'quota_exhausted',
        shouldRun: false,
        reason: `会话配额已耗尽（$${sessionBudget.spentUsd.toFixed(2)} / $${sessionBudget.maxBudgetUsd.toFixed(2)}）`,
      }
    }
    return { route: 'no_goal', shouldRun: true }
  }

  const goal = goalProvider(goalId)
  if (!goal) {
    return { route: 'no_goal', shouldRun: true, reason: 'Goal 不存在，跳过约束' }
  }

  // goal 终止
  if (goal.phase === 'completed' || goal.phase === 'archived') {
    return { route: 'goal_terminated', shouldRun: false, goal, reason: '目标已完成或已归档' }
  }

  // 有未解决的用户门控 → 需要人类判断
  const openGate = goal.gates.find((g) => g.status === 'open')
  if (openGate) {
    return {
      route: 'wait_user_action',
      shouldRun: false,
      goal,
      reason: `等待处理用户门控：${openGate.question}`,
    }
  }

  // todo 分析
  const actionable = goal.todos.filter((t) => ['open', 'claimed', 'in_progress'].includes(t.status))
  if (actionable.length === 0) {
    return {
      route: 'blocked',
      shouldRun: false,
      goal,
      reason: 'Goal 没有可执行的 todo（需先添加 todo 或提出下一步）',
    }
  }

  // 配额检查
  const quota = goal.quota
  if (quota?.maxBudgetUsd !== undefined && (quota.spentUsd ?? 0) >= quota.maxBudgetUsd) {
    return {
      route: 'quota_exhausted',
      shouldRun: false,
      goal,
      reason: `Goal 配额已耗尽（$${(quota.spentUsd ?? 0).toFixed(2)} / $${quota.maxBudgetUsd.toFixed(2)}）`,
    }
  }

  // 手动发消息：即使可以自动执行，也返回 ready；但如果用户手动操作，允许跳过 could-run
  const decision: TurnDecision = {
    route: 'ready',
    shouldRun: true,
    goal,
    reason: 'Goal 可推进',
  }
  // 如果用户手动发送消息，覆盖 shouldRun=true（人类触发优先）
  if (userMessage !== undefined && userMessage.trim()) {
    decision.shouldRun = true
  }
  return decision
}

/**
 * 便捷：直接判断一个 Goal 当前是否会自动推进（供自动化/定时任务使用）。
 */
export function shouldAutoAdvanceGoal(
  goalId: string,
  deps: { getGoal: (id: string) => Goal | undefined; shouldGoalRun: (id: string) => { shouldRun: boolean; reason?: string } } = { getGoal, shouldGoalRun },
): TurnDecision {
  const decision = preTickTurn(goalId, undefined, deps)
  // 复用 goal-service 的 shouldGoalRun 作为权威判断
  const run = deps.shouldGoalRun(goalId)
  return {
    ...decision,
    route: run.shouldRun ? 'ready' : mapBlockReason(run.reason),
    shouldRun: run.shouldRun,
    reason: run.reason,
  }
}

function mapBlockReason(reason: string | undefined): TurnRoute {
  switch (reason) {
    case 'waiting_user': return 'wait_user_action'
    case 'quota_exhausted': return 'quota_exhausted'
    case 'goal_terminated': return 'goal_terminated'
    case 'no_actionable_todo':
    case 'goal_not_found': return 'blocked'
    default: return 'blocked'
  }
}

/** 把 TurnRoute 映射为人类可读标签 */
export function routeLabel(route: TurnRoute): string {
  const map: Record<TurnRoute, string> = {
    ready: '可推进',
    wait_user_action: '等待用户',
    blocked: '被阻塞',
    quota_exhausted: '配额耗尽',
    goal_terminated: '目标终止',
    replan_required: '需重规划',
    repair_required: '需修复',
    no_goal: '无约束',
  }
  return map[route] ?? route
}

/** Next todo 推荐（供 UI 展示） */
export function nextActionableTodo(goal: Goal | undefined): GoalTodo | undefined {
  if (!goal) return undefined
  const priority: GoalTodo['status'][] = ['in_progress', 'claimed', 'open']
  for (const status of priority) {
    const todo = goal.todos.find((t) => t.status === status)
    if (todo) return todo
  }
  return undefined
}

/** 全局单例入口（无状态，提供便利） */
export const turnDecisionService = { preTickTurn, shouldAutoAdvanceGoal, routeLabel }
