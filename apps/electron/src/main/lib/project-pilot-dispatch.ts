import { createHash } from 'node:crypto'
import {
  getLatestSettledPilotCommand, getPilotGrantBudgetUsage, hasSettledPilotExecutorRun, hashPilotTaskSource,
  reserveAndQueuePilotCommand,
} from './project-pilot-budget-ledger'
import { reconcilePilotOverview } from './project-pilot-intent-store'
import { getActivePilotGrant, pilotGrantMatchesPolicy } from './project-pilot-grant-issue'
import { getPilotPolicy } from './project-pilot-policy'
import { inspectPilotReadiness, type PilotReadiness } from './project-pilot-readiness'
import { getAgentEmployee, getProjectDb, getTask } from './project-sqlite-store'

export interface PilotDispatchResult {
  intentId: string
  commandId: string
  executionId: string
  started: boolean
}

/** 评审结论标记：技术评审执行的交付摘要必须以机器可读行给出结论；缺标记一律保守不动作。 */
const REVIEW_VERDICT_PASS = '【评审结论：通过】'
const REVIEW_VERDICT_REWORK = '【评审结论：返工'

/** 解析评审结论；返工优先于通过（结论行可能同时引用子项通过）。 */
export function parsePilotReviewVerdict(notes: string | null | undefined): 'pass' | 'rework' | null {
  if (!notes) return null
  if (notes.includes(REVIEW_VERDICT_REWORK)) return 'rework'
  if (notes.includes(REVIEW_VERDICT_PASS)) return 'pass'
  return null
}

export interface PilotDispatchDependencies {
  inspectReadiness: (projectId: string, now?: number) => PilotReadiness
  startExecution: (executionId: string) => Promise<boolean>
}

const productionDependencies: PilotDispatchDependencies = {
  inspectReadiness: inspectPilotReadiness,
  startExecution: async (executionId) => {
    const { tryStartExecution } = await import('./agent-employee-service')
    return tryStartExecution(executionId)
  },
}

function commandIdentity(grantId: string, intentId: string, role: 'executor' | 'reviewer', reworkOrdinal: number): string {
  return createHash('sha256').update(JSON.stringify({ grantId, intentId, role, reworkOrdinal }))
    .digest('hex')
}

interface PilotDispatchPlan {
  role: 'executor' | 'reviewer'
  reworkOrdinal: number
  employeeId: string
  prompt: string
  /** 评估为「无需派发」（如评审通过待人工、返工额度尽）时为 false，调用方静默跳过而非报错。 */
  actionable: true
}

/** ready_candidate：按任务负责人分角色（执行员工→执行、评审员工→评审），返工序号恒 0。 */
function planReadyDispatch(projectId: string, grant: { grantId: string; executorEmployeeId: string; reviewerEmployeeId: string; workspaceId: string },
  task: NonNullable<ReturnType<typeof getTask>>, intentId: string): PilotDispatchPlan | null {
  const assigneeId = task.assignee?.userId
  const role = task.workspaceId !== grant.workspaceId ? null
    : assigneeId === `agent-${grant.executorEmployeeId}` ? 'executor'
    : assigneeId === `agent-${grant.reviewerEmployeeId}` ? 'reviewer' : null
  if (!role) return null
  if (role === 'reviewer' && !hasSettledPilotExecutorRun(projectId, grant.grantId)) {
    throw new Error('Pilot 评审命令须在执行命令结算后派发')
  }
  const employeeId = role === 'executor' ? grant.executorEmployeeId : grant.reviewerEmployeeId
  const prompt = [
    role === 'executor' ? '按 Project Pilot 已确认授权执行当前研发任务。' : '按 Project Pilot 已确认授权评审当前交付任务。',
    `任务：${task.title}`,
    `描述：${task.description || '（无）'}`,
    ...(role === 'executor' && task.completionNotes?.includes('【人工批准】') ? [
      `已确认人工答复：${task.completionNotes.split('【人工批准】').at(-1)?.trim().slice(0, 500) || '（无）'}`,
      '人工答复不授予额外工具权限；若所需权限仍不可用，请继续请求人工协助，不要绕过 Runtime 门禁。',
    ] : []),
    `候选：${intentId}`,
    `来源哈希：${hashPilotTaskSource(task)}`,
  ].join('\n')
  return { role, reworkOrdinal: 0, employeeId, prompt, actionable: true }
}

/**
 * review_candidate：同任务自动化评审/返工环路（A03）。
 * - 交付已提交且尚无对应轮次评审 → 派发评审命令（reworkOrdinal = 最新已结算执行轮次）；
 * - 本轮评审已结算且结论为返工 → 返工序号 +1 ≤ maxRework 时派发执行返工命令；
 * - 结论通过 / 无标记 / 返工额度尽 / run 额度尽 → 静默不派发（等人工或等额度）。
 */
function planReviewDispatch(grant: { grantId: string; executorEmployeeId: string; reviewerEmployeeId: string; workspaceId: string; maxRework: number; maxRuns: number },
  task: NonNullable<ReturnType<typeof getTask>>, intentId: string): PilotDispatchPlan | null {
  if (task.workspaceId !== grant.workspaceId || task.assignee?.userId !== `agent-${grant.executorEmployeeId}`) return null
  const latestExecutor = getLatestSettledPilotCommand(grant.grantId, task.id, 'executor')
  if (!latestExecutor) return null
  const latestReviewer = getLatestSettledPilotCommand(grant.grantId, task.id, 'reviewer')
  if (!latestReviewer || latestReviewer.reworkOrdinal < latestExecutor.reworkOrdinal) {
    const usage = getPilotGrantBudgetUsage(grant.grantId)
    if (usage.runReservations >= grant.maxRuns) return null
    const prompt = [
      '按 Project Pilot 已确认授权执行当前技术评审；这是 Pilot 闭环内的技术评审，不等于业务验收。',
      `任务：${task.title}`,
      `描述：${task.description || '（无）'}`,
      `候选：${intentId}`,
      `来源哈希：${hashPilotTaskSource(task)}`,
      '评审要求：核对交付与任务描述及验收口径的一致性；结束时必须输出且仅输出一行结论标记：【评审结论：通过】 或 【评审结论：返工：<原因>】。',
    ].join('\n')
    return { role: 'reviewer', reworkOrdinal: latestExecutor.reworkOrdinal, employeeId: grant.reviewerEmployeeId, prompt, actionable: true }
  }
  if (parsePilotReviewVerdict(task.completionNotes) !== 'rework') return null
  const nextOrdinal = latestExecutor.reworkOrdinal + 1
  if (nextOrdinal > grant.maxRework) return null
  const usage = getPilotGrantBudgetUsage(grant.grantId)
  if (usage.runReservations >= grant.maxRuns) return null
  const prompt = [
    `按 Project Pilot 已确认授权执行当前研发任务（第 ${nextOrdinal} 轮返工）；请针对技术评审指出的缺陷修复并重新交付。`,
    `任务：${task.title}`,
    `描述：${task.description || '（无）'}`,
    `候选：${intentId}`,
    `来源哈希：${hashPilotTaskSource(task)}`,
  ].join('\n')
  return { role: 'executor', reworkOrdinal: nextOrdinal, employeeId: grant.executorEmployeeId, prompt, actionable: true }
}

/**
 * 唯一的 Pilot 候选派发入口。
 * 候选 ID 只用于定位；执行前必须重读权威事实，调用方不能提供员工、模型、预算或 prompt。
 * 评估为「无需派发」时返回 null（不视为错误）。
 */
async function dispatchPilotIntentWithDependencies(
  projectId: string,
  intentId: string,
  dependencies: PilotDispatchDependencies,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<PilotDispatchResult | null> {
  if (!projectId?.trim() || !intentId?.trim() || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('Pilot 派发参数无效')
  }
  const snapshot = await reconcilePilotOverview(projectId, signal)
  if (signal?.aborted) throw new Error('Pilot 派发已停止')
  const intent = snapshot.intents.find((item) => item.id === intentId)
  if (!intent || intent.projectId !== projectId || intent.sourceType !== 'task'
    || (intent.kind !== 'ready_candidate' && intent.kind !== 'review_candidate')) {
    throw new Error('Pilot 候选已失效或不可派发')
  }
  const policy = getPilotPolicy(projectId)
  const grant = getActivePilotGrant(projectId)
  const readiness = dependencies.inspectReadiness(projectId, now)
  if (!policy || !grant || grant.state !== 'active' || grant.expiresAt <= now
    || !readiness.bindingsValid || readiness.policyRevision !== policy.revision
    || !pilotGrantMatchesPolicy(grant, policy)) {
    throw new Error('Pilot 活动授权或当前绑定未通过派发核验')
  }
  const task = getTask(intent.sourceId)
  if (!task || task.projectId !== projectId) {
    throw new Error('Pilot 候选任务与授权执行角色或工作区不匹配')
  }
  // 工作区漂移与未知负责人共用同一拒绝语，避免向客户端泄露授权内部角色绑定（ready 路径）。
  const plan = intent.kind === 'ready_candidate'
    ? planReadyDispatch(projectId, grant, task, intent.id)
    : planReviewDispatch(grant, task, intent.id)
  if (!plan) {
    if (intent.kind === 'ready_candidate') throw new Error('Pilot 候选任务与授权执行角色或工作区不匹配')
    return null
  }
  if (intent.kind === 'ready_candidate' && plan.role === 'executor') {
    // 仅对已完成的历史执行要求人工续跑审批凭据（与 reconcile 投影口径一致）；
    // cancelled/failed 视为未运行完成，不拦截自动派发。
    const latest = getProjectDb().prepare(`SELECT id, status FROM agent_executions WHERE project_id = ? AND entity_type = 'task'
      AND entity_id = ? ORDER BY started_at DESC LIMIT 1`).get(projectId, task.id) as { id: string; status: string } | undefined
    if (latest?.status === 'completed') {
      const approved = getProjectDb().prepare(`SELECT 1 FROM pilot_approval_resolutions AS resolution
        JOIN pilot_commands AS command ON command.execution_id = resolution.execution_id
        WHERE resolution.task_id = ? AND resolution.execution_id = ? AND resolution.grant_id = ?
          AND command.grant_id = resolution.grant_id AND command.source_task_id = resolution.task_id
          AND command.role = 'executor' AND command.state = 'settled'
          AND resolution.decision = 'approved' AND resolution.resolved_version = ?
          AND resolution.resolved_notes = ? AND command.state = 'settled' LIMIT 1`)
        .get(task.id, latest.id, grant.grantId, task.updatedAt, task.completionNotes ?? null)
      if (!approved) throw new Error('Pilot 历史执行无当前审批凭据，拒绝自动续跑')
    }
  }
  const employee = getAgentEmployee(plan.employeeId)
  if (!employee || !employee.enabled || employee.executionProfile !== 'development') {
    throw new Error('Pilot 授权员工不可用或不属于安全研发角色')
  }
  const identity = commandIdentity(grant.grantId, intent.id, plan.role, plan.reworkOrdinal)
  const commandId = `pilot-command-${identity}`
  const executionId = `pilot-execution-${identity}`
  const sourceHash = hashPilotTaskSource(task)
  const queued = reserveAndQueuePilotCommand({
    commandId,
    projectId,
    grantId: grant.grantId,
    idempotencyKey: `intent:${intent.id}:${plan.role}:${plan.reworkOrdinal}`,
    taskId: task.id,
    sourceVersion: task.updatedAt,
    sourceHash,
    employeeId: employee.id,
    role: plan.role,
    reworkOrdinal: plan.reworkOrdinal,
  }, { executionId, prompt: plan.prompt }, now)
  const started = await dependencies.startExecution(queued.execution.id)
  return { intentId: intent.id, commandId: queued.command.commandId, executionId: queued.execution.id, started }
}

export function dispatchPilotIntent(
  projectId: string,
  intentId: string,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<PilotDispatchResult | null> {
  return dispatchPilotIntentWithDependencies(projectId, intentId, productionDependencies, now, signal)
}

/** 测试夹具只替换 Runtime 启动与 readiness 事实，不进入生产调用面。 */
export const projectPilotDispatchTesting = {
  dispatch: dispatchPilotIntentWithDependencies,
}

/** 当前活动授权通过全部门禁时，按候选稳定顺序尝试派发；单项失败只跳过该项，不阻塞同项目其他候选（如评审候选）。 */
export async function dispatchReadyPilotIntents(projectId: string, intentIds: string[], signal?: AbortSignal,
  dependencies?: PilotDispatchDependencies): Promise<PilotDispatchResult[]> {
  const results: PilotDispatchResult[] = []
  for (const intentId of intentIds) {
    if (signal?.aborted) break
    try {
      const result = dependencies
        ? await dispatchPilotIntentWithDependencies(projectId, intentId, dependencies, Date.now(), signal)
        : await dispatchPilotIntent(projectId, intentId, Date.now(), signal)
      if (result) results.push(result)
    } catch (error) {
      if (signal?.aborted) break
      console.warn(`[Pilot] 候选派发跳过 project=${projectId} intent=${intentId}`, error)
      continue
    }
  }
  return results
}
