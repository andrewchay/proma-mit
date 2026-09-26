import { randomUUID } from 'node:crypto'
import { getAgentExecution, getProject, getProjectDb } from './project-sqlite-store'

/** 执行来源的持久核验记录。仅证明关联，不代表命令获得执行授权。 */
export interface PilotCommandLink {
  commandId: string
  projectId: string
  policyRevision: number
  executionId: string
  createdAt: number
}

interface LinkRow {
  command_id: string
  project_id: string
  policy_revision: number
  execution_id: string
  created_at: number
}

function fromRow(row: LinkRow): PilotCommandLink {
  return { commandId: row.command_id, projectId: row.project_id, policyRevision: row.policy_revision,
    executionId: row.execution_id, createdAt: row.created_at }
}

/** 启动前的来源核验；只有标记和持久关联同时匹配才可进入授权检查。 */
export function assertPilotExecutionLinked(executionId: string, expectedPolicyRevision?: number): PilotCommandLink {
  const execution = getAgentExecution(executionId)
  if (!execution?.pilotCommandId) throw new Error('执行缺少 Pilot 命令归属')
  const row = getProjectDb().prepare(
    'SELECT * FROM pilot_command_links WHERE command_id = ? AND project_id = ? AND execution_id = ?'
  ).get(execution.pilotCommandId, execution.projectId, execution.id) as LinkRow | undefined
  if (!row) throw new Error('Pilot 命令关联无法核验')
  if (expectedPolicyRevision !== undefined && row.policy_revision !== expectedPolicyRevision) {
    throw new Error('Pilot 命令对应的策略版本已失效')
  }
  return fromRow(row)
}

export function listPilotCommandLinks(projectId: string): PilotCommandLink[] {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目 ID')
  const rows = getProjectDb().prepare('SELECT * FROM pilot_command_links WHERE project_id = ? ORDER BY command_id').all(projectId) as LinkRow[]
  return rows.map(fromRow)
}

/** 只登记来源；不会派发、启动、授权或通知。重复登记仅允许身份完全一致。 */
export function registerPilotCommandLink(input: Omit<PilotCommandLink, 'createdAt'>): PilotCommandLink {
  if (!input.commandId?.trim() || !input.projectId?.trim() || !input.executionId?.trim()
    || !Number.isSafeInteger(input.policyRevision) || input.policyRevision <= 0) throw new Error('Pilot 命令关联参数无效')
  const database = getProjectDb()
  let result: PilotCommandLink | undefined
  database.transaction(() => {
    const execution = getAgentExecution(input.executionId)
    if (!getProject(input.projectId) || !execution || execution.projectId !== input.projectId
      || execution.pilotCommandId !== input.commandId) throw new Error('Pilot 命令与执行归属不一致')
    const existing = database.prepare('SELECT * FROM pilot_command_links WHERE command_id = ? OR execution_id = ?')
      .all(input.commandId, input.executionId) as LinkRow[]
    if (existing.length > 0) {
      if (existing.length !== 1 || existing[0]!.command_id !== input.commandId
        || existing[0]!.project_id !== input.projectId || existing[0]!.execution_id !== input.executionId
        || existing[0]!.policy_revision !== input.policyRevision) throw new Error('Pilot 命令关联已被其他执行占用')
      result = fromRow(existing[0]!)
      return
    }
    const createdAt = Date.now()
    database.prepare('INSERT INTO pilot_command_links (command_id, project_id, policy_revision, execution_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.commandId, input.projectId, input.policyRevision, input.executionId, createdAt)
    result = { ...input, createdAt }
  })()
  return result!
}

/** 已确认暂停后的底层原子操作；调用方须先校验影响面与策略版本。任何一项已启动则整批不取消。 */
export function cancelLinkedQueuedPilotExecutions(projectId: string, targets: Array<{ executionId: string; commandId: string }>): string[] {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目 ID')
  if (new Set(targets.map((item) => item.executionId)).size !== targets.length) throw new Error('Pilot 排队执行重复')
  const database = getProjectDb()
  const cancelled: string[] = []
  database.transaction(() => {
    for (const target of targets) {
      const link = database.prepare('SELECT command_id FROM pilot_command_links WHERE command_id = ? AND project_id = ? AND execution_id = ?')
        .get(target.commandId, projectId, target.executionId) as { command_id: string } | undefined
      const execution = getAgentExecution(target.executionId)
      if (!link || !execution || execution.projectId !== projectId || execution.pilotCommandId !== target.commandId
        || execution.status !== 'queued' || execution.sessionId !== '') {
        throw new Error('Pilot 排队执行已变化或命令归属无法核验，请重新预览')
      }
    }
    for (const target of targets) {
      const now = Date.now()
      const updated = database.prepare(`UPDATE agent_executions SET status = 'cancelled', error = ?, completed_at = ?
        WHERE id = ? AND project_id = ? AND pilot_command_id = ? AND status = 'queued' AND session_id = ''`)
        .run('用户确认暂停 Pilot，取消尚未启动的排队执行', now, target.executionId, projectId, target.commandId)
      if (updated.changes !== 1) throw new Error('Pilot 排队执行已变化，请重新预览')
      database.prepare(`INSERT INTO project_activities
        (id, project_id, entity_type, entity_id, action, summary, payload, actor, created_at)
        VALUES (?, ?, 'task', ?, 'pilot_queued_cancelled', ?, ?, 'local-user', ?)`)
        .run(randomUUID(), projectId, target.executionId, '用户确认暂停后取消 Pilot 排队执行',
          JSON.stringify({ commandId: target.commandId, executionId: target.executionId }), now)
      cancelled.push(target.executionId)
    }
  })()
  return cancelled
}
