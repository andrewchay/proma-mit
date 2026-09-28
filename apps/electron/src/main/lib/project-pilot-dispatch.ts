import { createHash } from 'node:crypto'
import { hasSettledPilotExecutorRun, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { reconcilePilotOverview } from './project-pilot-intent-store'
import { getActivePilotGrant, pilotGrantMatchesPolicy } from './project-pilot-grant-issue'
import { getPilotPolicy } from './project-pilot-policy'
import { inspectPilotReadiness, type PilotReadiness } from './project-pilot-readiness'
import { getAgentEmployee, getTask } from './project-sqlite-store'

export interface PilotDispatchResult {
  intentId: string
  commandId: string
  executionId: string
  started: boolean
}

interface PilotDispatchDependencies {
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

/**
 * 唯一的 Pilot 候选派发入口。
 * 候选 ID 只用于定位；执行前必须重读权威事实，调用方不能提供员工、模型、预算或 prompt。
 */
async function dispatchPilotIntentWithDependencies(
  projectId: string,
  intentId: string,
  dependencies: PilotDispatchDependencies,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<PilotDispatchResult> {
  if (!projectId?.trim() || !intentId?.trim() || !Number.isSafeInteger(now) || now < 0) {
    throw new Error('Pilot 派发参数无效')
  }
  const snapshot = await reconcilePilotOverview(projectId, signal)
  if (signal?.aborted) throw new Error('Pilot 派发已停止')
  const intent = snapshot.intents.find((item) => item.id === intentId)
  if (!intent || intent.projectId !== projectId || intent.sourceType !== 'task' || intent.kind !== 'ready_candidate') {
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
  // 角色由任务负责人决定：执行员工派执行命令，评审员工派评审命令；其余一律拒绝。
  // 工作区漂移与未知负责人共用同一拒绝语，避免向客户端泄露授权内部角色绑定。
  const task = getTask(intent.sourceId)
  const assigneeId = task?.assignee?.userId
  const role: 'executor' | 'reviewer' | null = !task || task.projectId !== projectId || task.workspaceId !== grant.workspaceId ? null
    : assigneeId === `agent-${grant.executorEmployeeId}` ? 'executor'
    : assigneeId === `agent-${grant.reviewerEmployeeId}` ? 'reviewer' : null
  if (!task || !role) {
    throw new Error('Pilot 候选任务与授权执行角色或工作区不匹配')
  }
  if (role === 'reviewer' && !hasSettledPilotExecutorRun(projectId, grant.grantId)) {
    throw new Error('Pilot 评审命令须在执行命令结算后派发')
  }
  const employee = getAgentEmployee(role === 'executor' ? grant.executorEmployeeId : grant.reviewerEmployeeId)
  if (!employee || !employee.enabled || employee.executionProfile !== 'development') {
    throw new Error('Pilot 授权员工不可用或不属于安全研发角色')
  }
  const identity = commandIdentity(grant.grantId, intent.id, role, 0)
  const commandId = `pilot-command-${identity}`
  const executionId = `pilot-execution-${identity}`
  const sourceHash = hashPilotTaskSource(task)
  const prompt = [
    role === 'executor' ? '按 Project Pilot 已确认授权执行当前研发任务。' : '按 Project Pilot 已确认授权评审当前交付任务。',
    `任务：${task.title}`,
    `描述：${task.description || '（无）'}`,
    `候选：${intent.id}`,
    `来源哈希：${sourceHash}`,
  ].join('\n')
  const queued = reserveAndQueuePilotCommand({
    commandId,
    projectId,
    grantId: grant.grantId,
    idempotencyKey: `intent:${intent.id}:${role}:0`,
    taskId: task.id,
    sourceVersion: task.updatedAt,
    sourceHash,
    employeeId: employee.id,
    role,
    reworkOrdinal: 0,
  }, { executionId, prompt }, now)
  const started = await dependencies.startExecution(queued.execution.id)
  return { intentId: intent.id, commandId: queued.command.commandId, executionId: queued.execution.id, started }
}

export function dispatchPilotIntent(
  projectId: string,
  intentId: string,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<PilotDispatchResult> {
  return dispatchPilotIntentWithDependencies(projectId, intentId, productionDependencies, now, signal)
}

/** 测试夹具只替换 Runtime 启动与 readiness 事实，不进入生产调用面。 */
export const projectPilotDispatchTesting = {
  dispatch: dispatchPilotIntentWithDependencies,
}

/** 当前活动授权通过全部门禁时，按候选稳定顺序尝试派发；单项失败只跳过该项，不阻塞同项目其他候选（如评审候选）。 */
export async function dispatchReadyPilotIntents(projectId: string, intentIds: string[], signal?: AbortSignal): Promise<PilotDispatchResult[]> {
  const results: PilotDispatchResult[] = []
  for (const intentId of intentIds) {
    if (signal?.aborted) break
    try {
      results.push(await dispatchPilotIntent(projectId, intentId, Date.now(), signal))
    } catch (error) {
      if (signal?.aborted) break
      console.warn(`[Pilot] 候选派发跳过 project=${projectId} intent=${intentId}`, error)
      continue
    }
  }
  return results
}
