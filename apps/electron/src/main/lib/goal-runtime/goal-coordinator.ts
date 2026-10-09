/** Goal 控制平面：状态机、检查点校验和有限续跑调度。 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  AgentGoal,
  AgentGoalCheckpoint,
  AgentGoalPreparedRequest,
  AgentGoalInvocationContext,
  AgentGoalStatus,
  CreateAgentGoalInput,
  GoalCompletionGate,
  PinnedVerifierReceipt,
} from '@gravitas/shared'
import { ElectronGoalStore } from './goal-store'
import { resolveHeadCommitSha, runPinnedBaselineVerifier } from '../pinned-baseline-verifier'
import { assessProtectedPathChanges } from '../completion-protected-paths'
import { ProtectedVerifierStore } from '../protected-verifier-store'

const MAX_IMMEDIATE_CONTINUATIONS = 3

/** 仅由主进程签发，模型只能提交checkpoint内容，不能指定身份。 */
export interface AgentGoalRunCallbacks {
  readonly goalId: string
  readonly runId: string
  onPrepared(request: AgentGoalPreparedRequest): Promise<void>
  onCheckpoint(checkpoint: AgentGoalCheckpoint): Promise<void>
  onFinished(canContinue: boolean): Promise<void>
}

export interface GoalContinuationRequest {
  goal: AgentGoal
  prompt: string
}

/** 返回 false 表示执行环境暂不可用；协调器会保留 Goal 并稍后重试，不会丢失续跑。 */
export type GoalContinuationRunner = (request: GoalContinuationRequest) => Promise<boolean>

/** 完成门禁的判定：通过与否、原因、以及固定基线回执（若已运行）。 */
export interface CompletionDecision {
  readonly passed: boolean
  readonly reasons: readonly string[]
  readonly receipt?: PinnedVerifierReceipt
}

/** 完成门禁的验证函数；默认检查 HEAD 已提交内容、基线之后的受保护路径与签名配置。 */
export type CompletionVerifier = (gate: GoalCompletionGate) => Promise<CompletionDecision>

export interface GoalCoordinatorOptions {
  verifyCompletion?: CompletionVerifier
  /** 受保护验证配置存储；默认使用应用配置目录。 */
  verifierStore?: ProtectedVerifierStore
}

function createDefaultCompletionVerifier(store: () => ProtectedVerifierStore): CompletionVerifier {
  return async (gate) => {
    let stored: ReturnType<ProtectedVerifierStore['verifyRef']>
    try {
      // 先做本地绑定校验（廉价）；配置与受保护路径只以统一存储的签名记录为准。
      stored = store().verifyRef(gate.verifierRef)
    } catch (error) {
      return { passed: false, reasons: [error instanceof Error ? error.message : '验证配置绑定校验失败'] }
    }
    const headCommitSha = await resolveHeadCommitSha(gate.repoRoot)
    const protectedCheck = await assessProtectedPathChanges({
      repoRoot: gate.repoRoot, baselineCommitSha: gate.baselineCommitSha, headCommitSha, protectedPaths: stored.record.protectedPaths,
    })
    if (!protectedCheck.ok) {
      return { passed: false, reasons: [...protectedCheck.reasons, ...protectedCheck.violations.map((path) => `protected:${path}`)] }
    }
    const receipt = await runPinnedBaselineVerifier({ repoRoot: gate.repoRoot, commitSha: headCommitSha, config: stored.record.config })
    return { passed: receipt.verdict === 'passed', reasons: receipt.reasons, receipt }
  }
}

export class GoalCoordinator {
  private readonly immediateCounts = new Map<string, number>()
  private readonly startingGoalIds = new Set<string>()
  private continuationRunner?: GoalContinuationRunner
  private readonly verifyCompletion: CompletionVerifier
  private readonly verifierStore: () => ProtectedVerifierStore
  private lazyVerifierStore?: ProtectedVerifierStore

  constructor(private readonly store = new ElectronGoalStore(), options: GoalCoordinatorOptions = {}) {
    this.verifierStore = () => {
      if (options.verifierStore) return options.verifierStore
      this.lazyVerifierStore ??= new ProtectedVerifierStore()
      return this.lazyVerifierStore
    }
    this.verifyCompletion = options.verifyCompletion ?? createDefaultCompletionVerifier(this.verifierStore)
  }

  setContinuationRunner(runner: GoalContinuationRunner): void {
    this.continuationRunner = runner
  }

  create(input: CreateAgentGoalInput): AgentGoal {
    const objective = input.objective.trim()
    if (!objective) throw new Error('Goal 目标不能为空')
    const existing = this.getActiveBySession(input.sessionId)
    if (existing) throw new Error('当前会话已有未结束的 Goal，请先暂停、取消或完成它')
    const completionGate = input.completionGate ? validateCompletionGate(input.completionGate, this.verifierStore()) : undefined
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
      ...(completionGate ? { completionGate } : {}),
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

  /** 为未在运行的 Goal 绑定完成门禁；绑定后完成必须经过固定基线验证。 */
  bindCompletionGate(goalId: string, gate: GoalCompletionGate): AgentGoal {
    const goal = this.requireGoal(goalId)
    if (goal.status === 'completed' || goal.status === 'cancelled') throw new Error('Goal 已结束，不能绑定门禁')
    if (goal.activeRunId) throw new Error('Goal 正在运行，暂停后再绑定门禁')
    const validated = validateCompletionGate(gate, this.verifierStore())
    return this.save({ ...goal, completionGate: validated, updatedAt: Date.now() })
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
    const next = this.save({
      ...goal,
      status,
      checkpoint: resumedCheckpoint,
      // 停止或暂停后，该 run 已不再属于可恢复的 Goal。清空它可避免 UI
      // 和恢复逻辑把旧 run 误判成仍在占用当前会话。
      activeRunId: undefined,
      checkpointRunId: undefined,
      updatedAt: Date.now(),
    })
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
      activeRunId: undefined,
      checkpointRunId: undefined,
      checkpoint: { ...goal.checkpoint, outcome: 'waiting', wakeTrigger: { type: 'user_input' } },
      updatedAt: Date.now(),
    })
  }

  /** 真正抢占运行槽位后签发；排队、压缩和槽位抢占前预检不创建Goal run。 */
  captureRun(sessionId: string): AgentGoalRunCallbacks | undefined {
    const goal = this.getActiveBySession(sessionId)
    if (!goal) return undefined
    const runId = randomUUID()
    this.save({
      ...goal, status: 'active', activeRunId: runId,
      checkpoint: undefined, checkpointRunId: undefined, invocationContext: undefined, updatedAt: Date.now(),
    })
    let finished = false
    let context: AgentGoalInvocationContext | undefined
    const configuration = goalConfiguration(goal)
    const readCurrent = (): AgentGoal => {
      const current = this.get(goal.id)
      if (finished || !current || current.sessionId !== sessionId || current.status !== 'active' || current.activeRunId !== runId) {
        throw new Error('Goal检查点调用身份已失效，请基于当前运行重新提交')
      }
      if (goalConfiguration(current) !== configuration) throw new Error('Goal配置已变化，请重新运行')
      return current
    }
    return Object.freeze({
      goalId: goal.id,
      runId,
      onPrepared: async (request: AgentGoalPreparedRequest): Promise<void> => {
        const current = readCurrent()
        if (context) throw new Error('Goal请求已准备，不能重复准备')
        const prepared = copyPreparedRequest(request)
        if (prepared.runtime !== goal.runtime ||
          (goal.workspaceId !== undefined && prepared.workspaceId !== goal.workspaceId) ||
          (goal.channelId !== undefined && prepared.channelId !== goal.channelId) ||
          (goal.modelId !== undefined && prepared.requestedModelId !== goal.modelId)) {
          throw new Error('Goal配置与已准备请求不一致，禁止跨环境提交')
        }
        const nextContext: AgentGoalInvocationContext = {
          ...prepared, version: 1, sourcePhase: 'prepared-request',
          goalId: goal.id, sessionId, runId, preparedAt: Date.now(),
        }
        this.save({ ...current, invocationContext: nextContext, updatedAt: Date.now() })
        context = Object.freeze(nextContext)
      },
      onCheckpoint: async (checkpoint: AgentGoalCheckpoint): Promise<void> => {
        const current = readCurrent()
        if (!context) throw new Error('Goal请求未准备，不能提交检查点')
        if (JSON.stringify(current.invocationContext) !== JSON.stringify(context)) {
          throw new Error('Goal调用上下文已变化，请重新运行')
        }
        validateCheckpoint(checkpoint, current)
        let receipt: PinnedVerifierReceipt | undefined
        if (checkpoint.outcome === 'complete' && current.completionGate) {
          // 验证耗时较长：返回后必须重新确认目标、配置与调用身份仍未变化。
          const decision = await this.verifyCompletion(current.completionGate)
          const latest = readCurrent()
          if (JSON.stringify(latest.invocationContext) !== JSON.stringify(context) || goalConfiguration(latest) !== configuration) {
            throw new Error('Goal配置或调用上下文已变化，请重新运行')
          }
          if (!decision.passed) {
            const reasons = decision.reasons.length > 0 ? decision.reasons.join('、') : '未知原因'
            throw new Error(`固定基线验证未通过：${reasons}。请修复已提交内容后再提交 complete。`)
          }
          receipt = decision.receipt
        }
        const latest = readCurrent()
        this.save({
          ...latest, status: statusFromCheckpoint(checkpoint), checkpoint: cloneCheckpoint(checkpoint),
          checkpointRunId: runId, activeRunId: undefined, updatedAt: Date.now(),
          ...(receipt ? { completionVerification: receipt } : {}),
        })
      },
      onFinished: async (canContinue: boolean): Promise<void> => {
        if (finished) return
        finished = true
        const current = this.get(goal.id)
        if (!current || current.sessionId !== sessionId) return
        // 没有本轮检查点时等待用户，不能复用上一轮continue；旧finally不改写新run。
        if (current.activeRunId === runId) {
          this.waitForUser(current, '本轮未提交有效Goal检查点，等待用户确认继续。')
          return
        }
        if (current.activeRunId || current.checkpointRunId !== runId || current.status !== 'active') return
        if (!context || goalConfiguration(current) !== configuration ||
          JSON.stringify(current.invocationContext) !== JSON.stringify(context)) {
          this.waitForUser(current, 'Goal配置或调用上下文已变化，不自动续跑。')
          return
        }
        if (!canContinue) {
          this.waitForUser(current, '本轮已停止或有用户输入待处理，不自动续跑。')
          return
        }
        if (current.checkpoint?.wakeTrigger?.type === 'immediate') await this.schedule(current)
      },
    })
  }

  private waitForUser(goal: AgentGoal, blocker: string): void {
    this.save({
      ...goal, status: 'waiting', activeRunId: undefined, updatedAt: Date.now(),
      checkpoint: {
        ...(goal.checkpoint ?? { summary: blocker, completed: [], evidence: [] }),
        outcome: 'waiting', wakeTrigger: { type: 'user_input' }, blocker,
      },
    })
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
    if (!goal || goal.status !== 'active' || goal.activeRunId || !this.continuationRunner) return
    this.startingGoalIds.add(goalId)
    try {
      // runId只在Orchestrator实际准入时签发，不为尚未启动的续跑预造身份。
      const started = await this.continuationRunner({
        goal,
        prompt: buildContinuationPrompt(goal),
      })
      if (!started) {
        const current = this.get(goalId)
        if (current?.version === goal.version && current.status === 'active') {
          setTimeout(() => { void this.startContinuation(goalId) }, 2_000)
        }
      }
    } catch (error) {
      console.error(`[Goal] 自动续跑失败: ${goalId}`, error)
      const current = this.get(goalId)
      if (current?.version === goal.version && current.status === 'active') {
        this.waitForUser(current, '自动续跑失败，等待用户恢复。')
      }
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

/** 只比较调用授权配置与完成门禁引用，不把状态/version更新当成新配置。 */
function goalConfiguration(goal: AgentGoal): string {
  return JSON.stringify({
    workspaceId: goal.workspaceId, channelId: goal.channelId, modelId: goal.modelId,
    runtime: goal.runtime, objective: goal.objective, acceptanceCriteria: goal.acceptanceCriteria,
    completionGate: goal.completionGate,
  })
}

/** 创建时即校验门禁，避免把非法验证配置存入 Goal。 */
function validateCompletionGate(gate: GoalCompletionGate, verifiers: ProtectedVerifierStore): GoalCompletionGate {
  if (gate.version !== 1) throw new Error('completionGate version 必须为 1')
  if (!isAbsolute(gate.repoRoot)) throw new Error('completionGate.repoRoot 必须是绝对路径')
  if (!/^[0-9a-f]{40}$/.test(gate.baselineCommitSha)) throw new Error('baselineCommitSha 必须是完整的 40 位小写十六进制 SHA')
  // 引用必须与统一存储中的当前签名记录一致；门禁不再内嵌配置或受保护路径。
  verifiers.verifyRef(gate.verifierRef)
  return { version: 1, repoRoot: gate.repoRoot, baselineCommitSha: gate.baselineCommitSha, verifierRef: { ...gate.verifierRef } }
}

function copyPreparedRequest(request: AgentGoalPreparedRequest): AgentGoalPreparedRequest {
  const required = [request.cwd, request.channelId, request.provider]
  const optional = [request.workspaceId, request.requestedModelId]
  if (required.some((value) => typeof value !== 'string' || !value.trim()) ||
    optional.some((value) => value !== undefined && (typeof value !== 'string' || !value.trim())) ||
    !isAbsolute(request.cwd) || !['proma', 'pi', 'ai-sdk'].includes(request.runtime)) {
    throw new Error('Goal请求上下文无效')
  }
  return {
    runtime: request.runtime, workspaceId: request.workspaceId, cwd: request.cwd,
    channelId: request.channelId, provider: request.provider, requestedModelId: request.requestedModelId,
  }
}
