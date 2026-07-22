/** Goal 控制平面：状态机、检查点校验和有限续跑调度。 */

import { randomUUID } from 'node:crypto'
import type {
  AgentGoal,
  AgentGoalCheckpoint,
  AgentGoalStatus,
  CreateAgentGoalInput,
} from '@proma/shared'
import { ElectronGoalStore } from './goal-store'

const MAX_IMMEDIATE_CONTINUATIONS = 3

export interface GoalContinuationRequest {
  goal: AgentGoal
  prompt: string
}

/** 返回 false 表示执行环境暂不可用；协调器会保留 Goal 并稍后重试，不会丢失续跑。 */
export type GoalContinuationRunner = (request: GoalContinuationRequest) => Promise<boolean>

export class GoalCoordinator {
  private readonly immediateCounts = new Map<string, number>()
  private readonly startingGoalIds = new Set<string>()
  private continuationRunner?: GoalContinuationRunner

  constructor(private readonly store = new ElectronGoalStore()) {}

  setContinuationRunner(runner: GoalContinuationRunner): void {
    this.continuationRunner = runner
  }

  create(input: CreateAgentGoalInput): AgentGoal {
    const objective = input.objective.trim()
    if (!objective) throw new Error('Goal 目标不能为空')
    const existing = this.getActiveBySession(input.sessionId)
    if (existing) throw new Error('当前会话已有未结束的 Goal，请先暂停、取消或完成它')
    const now = Date.now()
    const goal: AgentGoal = {
      id: randomUUID(),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      modelId: input.modelId,
      runtime: input.runtime,
      objective,
      acceptanceCriteria: input.acceptanceCriteria?.filter(Boolean) ?? [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    return this.store.save(goal, 'created')
  }

  get(goalId: string): AgentGoal | undefined {
    return this.store.get(goalId)
  }

  getActiveBySession(sessionId: string): AgentGoal | undefined {
    return this.store.getBySession(sessionId).find((goal) => goal.status === 'active' || goal.status === 'waiting')
  }

  listBySession(sessionId: string): AgentGoal[] {
    return this.store.getBySession(sessionId)
  }

  setStatus(goalId: string, status: Exclude<AgentGoalStatus, 'completed'>): AgentGoal {
    const goal = this.requireGoal(goalId)
    const resumedCheckpoint = status === 'active'
      ? {
        ...(goal.checkpoint ?? { outcome: 'continue' as const, summary: '用户恢复 Goal', completed: [], evidence: [] }),
        outcome: 'continue' as const,
        nextAction: goal.checkpoint?.nextAction ?? '继续推进 Goal 并提交新的检查点',
        wakeTrigger: { type: 'immediate' as const },
        blocker: undefined,
      }
      : goal.checkpoint
    const next = this.save({ ...goal, status, checkpoint: resumedCheckpoint, updatedAt: Date.now() })
    if (status !== 'active') this.immediateCounts.delete(goalId)
    if (status === 'active') queueMicrotask(() => { void this.schedule(next) })
    return next
  }

  /** 用户在自动续跑间隙发言时暂停已排队续跑，让该输入成为下一轮的真实上下文。 */
  pauseForUserInput(sessionId: string): void {
    const goal = this.getActiveBySession(sessionId)
    if (!goal || goal.status !== 'active' || goal.checkpoint?.wakeTrigger?.type !== 'immediate') return
    this.save({
      ...goal,
      status: 'waiting',
      checkpoint: { ...goal.checkpoint, outcome: 'waiting', wakeTrigger: { type: 'user_input' } },
      updatedAt: Date.now(),
    })
  }

  async submitCheckpoint(sessionId: string, checkpoint: AgentGoalCheckpoint): Promise<AgentGoal | undefined> {
    const goal = this.getActiveBySession(sessionId)
    if (!goal) throw new Error('当前会话没有激活的 Goal')
    validateCheckpoint(checkpoint, goal)
    const next = this.save({
      ...goal,
      status: statusFromCheckpoint(checkpoint),
      checkpoint: cloneCheckpoint(checkpoint),
      activeRunId: undefined,
      updatedAt: Date.now(),
    })
    return next
  }

  /** 当前 Agent turn 已完全退出后再调度续跑，避免与会话并发守卫竞争。 */
  async onTurnFinished(sessionId: string): Promise<void> {
    const goal = this.getActiveBySession(sessionId)
    if (!goal || goal.status !== 'active' || goal.checkpoint?.wakeTrigger?.type !== 'immediate') return
    await this.schedule(goal)
  }

  /** 在应用重启后恢复可自动执行的 Goal；没有窗口时保留并延迟重试。 */
  async recoverDueGoals(now = Date.now()): Promise<void> {
    for (const goal of this.store.list()) {
      const trigger = goal.checkpoint?.wakeTrigger
      if (goal.status === 'active' && trigger?.type === 'immediate') {
        await this.schedule(goal)
      } else if (goal.status === 'waiting' && trigger?.type === 'at' && trigger.wakeAt <= now) {
        await this.schedule(this.save({ ...goal, status: 'active', updatedAt: now }))
      }
    }
  }

  private async schedule(goal: AgentGoal): Promise<void> {
    if (!this.continuationRunner || goal.status === 'blocked' || goal.status === 'completed' || goal.status === 'cancelled') return
    const trigger = goal.checkpoint?.wakeTrigger
    if (!trigger || trigger.type === 'user_input' || trigger.type === 'interaction' || trigger.type === 'external_task' || trigger.type === 'file_change') return
    if (trigger.type === 'at') {
      const delay = Math.max(0, trigger.wakeAt - Date.now())
      setTimeout(() => { void this.startContinuation(goal.id) }, delay)
      return
    }
    const count = (this.immediateCounts.get(goal.id) ?? 0) + 1
    this.immediateCounts.set(goal.id, count)
    if (count > MAX_IMMEDIATE_CONTINUATIONS) {
      this.save({
        ...goal,
        status: 'waiting',
        checkpoint: { ...goal.checkpoint!, outcome: 'waiting', wakeTrigger: { type: 'user_input' }, blocker: '已达到连续自动续跑上限，等待用户确认继续。' },
        updatedAt: Date.now(),
      })
      return
    }
    queueMicrotask(() => { void this.startContinuation(goal.id) })
  }

  private async startContinuation(goalId: string): Promise<void> {
    if (this.startingGoalIds.has(goalId)) return
    const goal = this.store.get(goalId)
    if (!goal || goal.status !== 'active' || !this.continuationRunner) return
    this.startingGoalIds.add(goalId)
    try {
      const active = this.save({ ...goal, status: 'active', activeRunId: randomUUID(), updatedAt: Date.now() })
      const started = await this.continuationRunner({
        goal: active,
        prompt: buildContinuationPrompt(active),
      })
      if (!started) {
        this.save({ ...active, activeRunId: undefined, updatedAt: Date.now() })
        setTimeout(() => { void this.startContinuation(goalId) }, 2_000)
      }
    } catch (error) {
      console.error(`[Goal] 自动续跑失败: ${goalId}`, error)
      this.save({
        ...goal,
        status: 'waiting',
        activeRunId: undefined,
        checkpoint: { ...goal.checkpoint!, outcome: 'waiting', wakeTrigger: { type: 'user_input' }, blocker: '自动续跑失败，等待用户恢复。' },
        updatedAt: Date.now(),
      })
    } finally {
      this.startingGoalIds.delete(goalId)
    }
  }

  private requireGoal(goalId: string): AgentGoal {
    const goal = this.store.get(goalId)
    if (!goal) throw new Error(`Goal 不存在: ${goalId}`)
    return goal
  }

  private save(goal: AgentGoal): AgentGoal {
    return this.store.save({ ...goal, version: goal.version + 1 })
  }
}

function validateCheckpoint(checkpoint: AgentGoalCheckpoint, goal: AgentGoal): void {
  if (!checkpoint.summary.trim()) throw new Error('GoalCheckpoint 必须包含 summary')
  if (checkpoint.outcome === 'continue' && (!checkpoint.nextAction?.trim() || checkpoint.wakeTrigger?.type !== 'immediate')) {
    throw new Error('continue 检查点必须包含 nextAction 和 immediate 唤醒条件')
  }
  if (checkpoint.outcome === 'waiting' && !checkpoint.wakeTrigger) throw new Error('waiting 检查点必须包含唤醒条件')
  if (checkpoint.outcome === 'blocked' && !checkpoint.blocker?.trim()) throw new Error('blocked 检查点必须包含 blocker')
  if (checkpoint.outcome === 'complete') {
    if (goal.acceptanceCriteria.length > 0 && checkpoint.evidence.length === 0) {
      throw new Error('存在验收条件的 Goal 完成时必须提供 evidence')
    }
  }
}

function statusFromCheckpoint(checkpoint: AgentGoalCheckpoint): AgentGoalStatus {
  if (checkpoint.outcome === 'complete') return 'completed'
  if (checkpoint.outcome === 'blocked') return 'blocked'
  if (checkpoint.outcome === 'waiting') return 'waiting'
  return 'active'
}

function buildContinuationPrompt(goal: AgentGoal): string {
  const checkpoint = goal.checkpoint
  return [
    `继续执行当前 Goal：${goal.objective}`,
    checkpoint?.summary ? `上一轮进展：${checkpoint.summary}` : '',
    checkpoint?.nextAction ? `下一步：${checkpoint.nextAction}` : '',
    '请基于已有会话和实际证据继续执行。完成本轮后必须调用 GoalCheckpoint。',
  ].filter(Boolean).join('\n')
}

function cloneCheckpoint(checkpoint: AgentGoalCheckpoint): AgentGoalCheckpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as AgentGoalCheckpoint
}
