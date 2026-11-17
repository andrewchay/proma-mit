/** 混合批次接替：保留已验收成果与费用记录，只为失败步骤建立新批次。 */
import type { ProjectOwnerGoalSubject } from '@gravitas/shared'
import { ownerExecutionHash } from './project-owner-execution-hash'
import { confirmOwnerExecutionGrantRevoke, getOwnerExecutionGrant, previewOwnerExecutionGrantRevoke } from './project-owner-execution-grant-issue'
import { readOwnerQualityAction } from './project-owner-quality-actions'
import * as store from './project-sqlite-store'

export interface MixedBatchCommand {
  id: string
  role: 'executor' | 'reviewer'
  state: string
  execution_id: string | null
  rework_ordinal: number
  actual_cost_micros: number | null
  usage_evidence: string | null
  execution_status: string | null
  task_id?: string
}

export interface MixedBatchInput {
  commands: readonly MixedBatchCommand[]
  pendingRequestReservations: number
  /** 已完成任务 -> 已验收的 artifactHash */
  acceptedByTask: ReadonlyMap<string, string>
  /** 任务 -> 当前冻结成果哈希；失败任务为 null */
  taskArtifactHash: ReadonlyMap<string, string | null>
  grantState: string
}

export type MixedBatchAssessment =
  | { ok: true; retainedTaskIds: string[]; failedCommandIds: string[]; supersededCommandIds: string[] }
  | { ok: false; blockers: string[] }

export function assessMixedBatch(input: MixedBatchInput): MixedBatchAssessment {
  const blockers: string[] = []
  if (input.commands.some(command => ['queued', 'running', 'reserved'].includes(command.state)))
    blockers.push('仍有运行中或排队的命令，不能接替')
  if (input.pendingRequestReservations > 0)
    blockers.push('仍有未结的请求占额，不能接替')
  if (input.commands.some(command => command.state !== 'settled' || command.actual_cost_micros === null || !command.usage_evidence))
    blockers.push('存在费用未知或未结算的命令，不能接替')
  if (!input.commands.some(command => command.execution_status === 'failed'))
    blockers.push('没有失败命令需要恢复')
  // 授权处于 needs_reconcile 时费用与停止状态都未收敛，必须先由用户对账，不能自动接替。
  if (input.grantState === 'needs_reconcile')
    blockers.push('授权处于待对账状态，需要先核对费用与停止结果')
  if (blockers.length) return { ok: false, blockers }
  // 同一任务可能同时有 executor 与 reviewer 两条已完成命令；按任务去重，避免把同一步骤重复计入保留清单。
  const retained = new Set<string>(), supersededCommandIds: string[] = []
  for (const command of input.commands) {
    const taskId = command.task_id
    if (!taskId) continue
    supersededCommandIds.push(command.id)
    if (command.execution_status !== 'completed' || retained.has(taskId)) continue
    const artifact = input.taskArtifactHash.get(taskId) ?? null
    const accepted = input.acceptedByTask.get(taskId) ?? null
    if (!artifact || !accepted || artifact !== accepted)
      blockers.push(`任务 ${taskId} 已完成但缺少可核对的验收依据，不能接替以免重复执行`)
    else retained.add(taskId)
  }
  if (blockers.length) return { ok: false, blockers }
  return {
    ok: true,
    retainedTaskIds: [...retained],
    failedCommandIds: input.commands.filter(command => command.execution_status === 'failed').map(command => command.id),
    supersededCommandIds,
  }
}

/** 接替前必须先暂停旧授权；返回后续写关联记录所需的事实。 */
export interface MixedBatchSupersessionPlan {
  projectId: string
  previousMaterializationId: string
  previousGrantId: string
  retainedTaskIds: string[]
  failedCommandIds: string[]
}

/** 读取并核对旧批次：命令、逐请求占额、验收依据与失败工作树。 */
export function readMixedBatchAssessment(subject: ProjectOwnerGoalSubject, previousMaterializationId: string): MixedBatchAssessment {
  const projectId = subject.projectId
  const database = store.getProjectDb()
  const commands = database.prepare(`SELECT c.id, c.role, c.state, c.execution_id, c.rework_ordinal, c.actual_cost_micros, c.usage_evidence,
      c.source_task_id AS task_id, e.status AS execution_status
    FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    LEFT JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.project_id=? AND g.materialization_id=?`).all(projectId, previousMaterializationId) as MixedBatchCommand[]
  const pending = database.prepare(`SELECT COUNT(*) AS count FROM project_owner_execution_request_reservations r
    JOIN project_owner_execution_commands c ON c.id=r.command_id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE g.project_id=? AND g.materialization_id=? AND r.state!='settled'`).get(projectId, previousMaterializationId) as { count: number }
  // 只认每个任务最新一轮的评审结论：旧轮次的 accepted 已被返工覆盖，不能作为「不重复执行」的依据。
  const latestReviewerByTask = new Map<string, MixedBatchCommand>()
  for (const command of commands) {
    if (!command.task_id || command.role !== 'reviewer') continue
    const current = latestReviewerByTask.get(command.task_id)
    if (!current || command.rework_ordinal >= current.rework_ordinal) latestReviewerByTask.set(command.task_id, command)
  }
  const acceptedByTask = new Map<string, string>(), taskArtifactHash = new Map<string, string | null>()
  for (const [taskId, command] of latestReviewerByTask) {
    let artifactHash: string | null = null
    try {
      const action = readOwnerQualityAction(command.id)
      if (action?.state === 'accepted') { artifactHash = action.artifactHash; acceptedByTask.set(taskId, action.artifactHash) }
    } catch { /* 验收记录不可核验时按缺失处理，由 assessMixedBatch 拒绝。 */ }
    taskArtifactHash.set(taskId, artifactHash)
  }
  return assessMixedBatch({
    commands, pendingRequestReservations: pending.count, acceptedByTask, taskArtifactHash,
    // 主体可能带 taskId；grant 查询必须用同一主体，否则会读到项目级授权。
    grantState: getOwnerExecutionGrant(subject)?.state ?? 'missing',
  })
}

/**
 * 接替第一步：核对旧批次并暂停旧授权。旧授权若仍为 active，必须经撤权预览确认无阻断；
 * 不允许绕过授权状态直接改库。此函数只产出现场事实，不写关联记录。
 */
export function planMixedBatchSupersession(subject: ProjectOwnerGoalSubject, previousMaterializationId: string): MixedBatchSupersessionPlan {
  const assessment = readMixedBatchAssessment(subject, previousMaterializationId)
  if (!assessment.ok) throw new Error(`混合批次暂不能接替：${assessment.blockers.join('；')}`)
  // 没有任何已完成步骤时不是「混合」批次：必须交回全失败/目标变更等既有接替规则，
  // 那些规则还带有方案形状校验与用量结算，绕过它们会漏掉保护。
  if (!assessment.retainedTaskIds.length) throw new Error('旧批次没有可保留的已完成步骤，交由既有接替规则处理')
  const grant = getOwnerExecutionGrant(subject)
  if (!grant) throw new Error('混合批次缺少原执行授权')
  if (grant.state === 'active') {
    const preview = previewOwnerExecutionGrantRevoke(subject, { grantId: grant.grantId })
    if (preview.blockers.length) throw new Error(`旧批次仍有未收敛的执行或费用，不能接替：${preview.blockers.join('；')}`)
    const closed = confirmOwnerExecutionGrantRevoke(subject, { grantId: grant.grantId, confirmedFingerprint: preview.fingerprint })
    if (closed.state !== 'paused') throw new Error('旧授权未能安全暂停；接替未开始')
  } else if (!['paused', 'archived'].includes(grant.state)) {
    throw new Error(`旧授权处于 ${grant.state}，需要先核对原授权`)
  }
  return {
    projectId: subject.projectId,
    previousMaterializationId,
    previousGrantId: grant.grantId,
    retainedTaskIds: assessment.retainedTaskIds,
    failedCommandIds: assessment.failedCommandIds,
  }
}

export interface MixedBatchSupersession {
  id: string
  projectId: string
  previousMaterializationId: string
  previousGrantId: string
  nextMaterializationId: string
  retainedTaskIds: string[]
  failedCommandIds: string[]
  createdAt: number
}

/** 接替第二步：新批次材料化成功后写入关联记录，让用户能追溯恢复过程。 */
export function recordMixedBatchSupersession(subject: ProjectOwnerGoalSubject, plan: MixedBatchSupersessionPlan, nextMaterializationId: string): MixedBatchSupersession {
  if (!nextMaterializationId.trim() || nextMaterializationId.startsWith('pending:'))
    throw new Error('接替关联必须指向已材料化的新批次')
  const body = {
    schemaVersion: 1 as const, projectId: subject.projectId, ...(subject.taskId ? { taskId: subject.taskId } : {}),
    previousMaterializationId: plan.previousMaterializationId, previousGrantId: plan.previousGrantId, nextMaterializationId,
    retainedTaskIds: plan.retainedTaskIds, failedCommandIds: plan.failedCommandIds, createdAt: Date.now(),
  }
  const id = `owner-mixed-supersession-${ownerExecutionHash(body).slice(0, 32)}`
  const record: MixedBatchSupersession = { ...body, id }
  store.getProjectDb().prepare(`INSERT OR IGNORE INTO project_owner_execution_batch_supersessions
    (id, project_id, previous_materialization_id, next_materialization_id, payload, integrity_hash, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, subject.projectId, plan.previousMaterializationId, nextMaterializationId, JSON.stringify(record), ownerExecutionHash(record), record.createdAt)
  return record
}

export function listMixedBatchSupersessions(projectId: string): MixedBatchSupersession[] {
  return (store.getProjectDb().prepare('SELECT payload, integrity_hash FROM project_owner_execution_batch_supersessions WHERE project_id=? ORDER BY created_at')
    .all(projectId) as Array<{ payload: string; integrity_hash: string }>).map(row => {
    const value = JSON.parse(row.payload) as MixedBatchSupersession
    if (ownerExecutionHash(value) !== row.integrity_hash) throw new Error('混合批次接替记录完整性无效')
    return value
  })
}
