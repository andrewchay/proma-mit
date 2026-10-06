import type { PilotInboxEntry } from '@gravitas/shared'
import { getActivePilotGrant } from './project-pilot-grant-issue'
import { reconcilePilotOverview } from './project-pilot-intent-store'
import { updateTaskIfVersion } from './project-service'
import { getTask, listAgentExecutionsByProject, getProjectDb, recordProjectActivity } from './project-sqlite-store'

/**
 * A04 主动询问：Pilot 执行说明中机器可读的人工协助标记。
 * 类别首批四类中的三类（交付验收走 review_candidate 既有通道，不经此标记）：
 * 【需要人工：权限】缺权限无法继续；【需要人工：决策】范围/方案待拍板；【需要人工：提问】缺关键信息。
 */
const HUMAN_REQUEST_PATTERN = /【需要人工：(权限|决策|提问)】([^\n【]*)/

/** 人工已答复标记：批准续跑 / 拒绝不执行；任一存在即该任务询问已决。 */
const APPROVAL_MARKERS = ['【人工批准', '【人工拒绝'] as const

export interface PilotHumanRequest {
  category: '权限' | '决策' | '提问'
  detail: string
}

/** 解析任务说明中的人工协助标记；已答复（含批准/拒绝标记）或无标记返回 null。 */
export function parsePilotHumanRequest(notes: string | null | undefined): PilotHumanRequest | null {
  if (!notes) return null
  const match = HUMAN_REQUEST_PATTERN.exec(notes)
  if (!match) return null
  if (APPROVAL_MARKERS.some((marker) => notes.includes(marker))) return null
  return { category: match[1] as PilotHumanRequest['category'], detail: match[2]?.trim() ?? '' }
}

function assertTaskPendingAnswer(projectId: string, taskId: string): {
  task: NonNullable<ReturnType<typeof getTask>>; request: PilotHumanRequest; executionId: string; grantId: string
} {
  if (!projectId?.trim() || !taskId?.trim()) throw new Error('Pilot 审批参数无效')
  const grant = getActivePilotGrant(projectId)
  if (!grant) throw new Error('项目没有活动 Pilot 授权，审批入口不可用')
  const task = getTask(taskId)
  if (!task || task.projectId !== projectId) throw new Error('审批任务与项目不匹配')
  const request = parsePilotHumanRequest(task.completionNotes)
  if (!request) throw new Error('该任务当前没有待答复的 Pilot 人工询问（已答复或不存在标记）')
  const latest = listAgentExecutionsByProject(projectId).find((item) => item.entityType === 'task' && item.entityId === taskId)
  const command = latest?.pilotCommandId ? getProjectDb().prepare(`SELECT state, grant_id, role, employee_id
    FROM pilot_commands WHERE id = ? AND source_task_id = ? AND project_id = ?`)
    .get(latest.pilotCommandId, taskId, projectId) as { state: string; grant_id: string; role: string; employee_id: string } | undefined : undefined
  if (task.status !== 'paused' || !latest || latest.status !== 'completed'
    || task.workspaceId !== grant.workspaceId || task.assignee?.userId !== `agent-${grant.executorEmployeeId}`
    || command?.state !== 'settled' || command.grant_id !== grant.grantId
    || command.role !== 'executor' || command.employee_id !== grant.executorEmployeeId
    || latest.agentId !== grant.executorEmployeeId || !latest.resultSummary?.includes(`【需要人工：${request.category}】`)
    || latest.resultSummary !== task.completionNotes) {
    throw new Error('人工询问来源或任务状态已变化，请刷新后重试')
  }
  return { task, request, executionId: latest.id, grantId: grant.grantId }
}

/**
 * A04 人工答复：批准自动续跑（任务回到待派发事实 → 事件唤醒后台对账 → ready_candidate 自动派发）；
 * 拒绝不执行（任务取消，候选随事实收敛失效）。答复本身不派发任何命令，只写任务事实。
 */
export async function resolvePilotApproval(projectId: string, taskId: string,
  decision: 'approved' | 'rejected', options: { sourceVersion: number; note?: string }): Promise<void> {
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('Pilot 审批决定无效')
  if (!Number.isSafeInteger(options?.sourceVersion)) throw new Error('Pilot 审批来源版本无效')
  const { task, request, executionId, grantId } = assertTaskPendingAnswer(projectId, taskId)
  if (task.updatedAt !== options.sourceVersion) throw new Error('人工询问版本已失效，请刷新后重试')
  const note = typeof options.note === 'string' ? options.note.trim().slice(0, 500) : ''
  if (decision === 'approved' && !note) throw new Error('批准续跑前请填写答复或已解决事项')
  const marker = decision === 'approved' ? `【人工批准】${note}` : `【人工拒绝】${note}`
  const resolvedNotes = `${task.completionNotes ?? ''}\n${marker}`
  // 审批凭据与版本核对/状态写入同一事务提交；事件在提交后唤醒对账。
  updateTaskIfVersion(taskId, options.sourceVersion, {
    status: decision === 'approved' ? 'pending' : 'cancelled', completionNotes: resolvedNotes,
  }, (current, resolved) => {
    const active = getActivePilotGrant(projectId)
    const command = getProjectDb().prepare(`SELECT state FROM pilot_commands
      WHERE execution_id = ? AND grant_id = ? AND source_task_id = ? AND role = 'executor'`)
      .get(executionId, grantId, taskId) as { state: string } | undefined
    if (command?.state !== 'settled' || current.status !== 'paused' || current.completionNotes !== task.completionNotes || active?.grantId !== grantId
      || listAgentExecutionsByProject(projectId).find((item) => item.entityType === 'task' && item.entityId === taskId)?.id !== executionId) {
      throw new Error('人工询问版本或授权已失效，请刷新后重试')
    }
    getProjectDb().prepare(`INSERT INTO pilot_approval_resolutions
      (task_id, execution_id, grant_id, source_version, resolved_version, resolved_notes, decision)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(taskId, executionId, grantId, options.sourceVersion,
      resolved.updatedAt, resolvedNotes, decision)
  })
  recordProjectActivity({
    projectId, entityType: 'task', entityId: taskId,
    action: decision === 'approved' ? 'pilot_approval_approved' : 'pilot_approval_rejected',
    summary: decision === 'approved'
      ? `Pilot 人工询问已批准（${request.category}）：${request.detail}${note ? `；备注：${note}` : ''}`
      : `Pilot 人工询问已拒绝（${request.category}）：${request.detail}${note ? `；备注：${note}` : ''}`,
    payload: { category: request.category, detail: request.detail },
    actor: 'local-user',
  })
}

/** 项目级收件箱（最小数据层）：待人工询问 + 待拍板决策 + 待审阅交付，均来自当前权威事实投影的 open 意图。 */
export async function listPilotInbox(projectId: string, signal?: AbortSignal): Promise<PilotInboxEntry[]> {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目 ID')
  const snapshot = await reconcilePilotOverview(projectId, signal)
  const openBySource = new Set(snapshot.intents
    .filter((intent) => intent.status === 'open').map((intent) => `${intent.sourceType}:${intent.sourceId}`))
  return snapshot.observation.attention
    .filter((attention) => openBySource.has(`${attention.sourceType}:${attention.sourceId}`))
    .filter((attention) => attention.sourceType !== 'approval' || (() => {
      try { return !!assertTaskPendingAnswer(projectId, attention.sourceId) } catch { return false }
    })())
    .map((attention) => ({
      sourceType: attention.sourceType,
      sourceId: attention.sourceId,
      taskId: attention.taskId,
      sourceVersion: attention.sourceVersion,
      reason: attention.reason,
    }))
}
