import { assertPilotCommandStartRecord } from './project-pilot-budget-ledger'
import { assertPilotExecutionLinked } from './project-pilot-command-links'
import { getAgentExecution, getProjectDb } from './project-sqlite-store'

interface GrantRow {
  id: string
  project_id: string
  policy_revision: number
  state: 'active' | 'paused'
  expires_at: number
}

interface CommandRow {
  id: string
  project_id: string
  grant_id: string
  state: 'reserved' | 'queued' | 'running' | 'settled' | 'released' | 'needs_reconcile'
  execution_id: string | null
  actual_cost_micros: number | null
}

export interface PilotRecoveryIssue {
  commandId: string
  reason: string
}

export interface PilotGrantRecoverySnapshot {
  grantId: string
  projectId: string
  grantState: 'active' | 'paused'
  reservedRecheckCommandIds: string[]
  queuedRecheckExecutionIds: string[]
  needsAttention: PilotRecoveryIssue[]
}

function hasUnexpectedReservationArtifacts(command: CommandRow): boolean {
  const database = getProjectDb()
  const link = database.prepare('SELECT command_id FROM pilot_command_links WHERE command_id = ?')
    .get(command.id) as { command_id: string } | undefined
  const execution = database.prepare('SELECT id FROM agent_executions WHERE pilot_command_id = ? LIMIT 1')
    .get(command.id) as { id: string } | undefined
  return command.execution_id !== null || Boolean(link) || Boolean(execution)
}

/** 重启后只读检查。可重检项仍需重新校验授权与来源；未知运行结果绝不自动重派。 */
export function inspectPilotGrantRecovery(grantId: string, now = Date.now()): PilotGrantRecoverySnapshot {
  if (typeof grantId !== 'string' || !grantId.trim()) throw new Error('缺少 Pilot 授权 ID')
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Pilot 时钟无效')
  const database = getProjectDb()
  let result: PilotGrantRecoverySnapshot | undefined
  database.transaction(() => {
    const grant = database.prepare('SELECT * FROM pilot_runtime_grants WHERE id = ?')
      .get(grantId) as GrantRow | undefined
    if (!grant) throw new Error('Pilot 授权不存在')
    const snapshot: PilotGrantRecoverySnapshot = {
      grantId, projectId: grant.project_id, grantState: grant.state,
      reservedRecheckCommandIds: [], queuedRecheckExecutionIds: [], needsAttention: [],
    }
    const commands = database.prepare('SELECT * FROM pilot_commands WHERE grant_id = ? ORDER BY id')
      .all(grantId) as CommandRow[]
    for (const command of commands) {
      if (command.project_id !== grant.project_id) {
        snapshot.needsAttention.push({ commandId: command.id, reason: '命令项目与授权不一致' })
        continue
      }
      if (((command.state === 'reserved' || command.state === 'queued') && command.actual_cost_micros !== null)
        || (command.state === 'released' && command.actual_cost_micros !== 0)
        || (command.state === 'settled' && (!Number.isSafeInteger(command.actual_cost_micros)
          || command.actual_cost_micros === null || command.actual_cost_micros < 0))) {
        snapshot.needsAttention.push({ commandId: command.id, reason: '命令费用与状态不一致' })
        continue
      }
      if (command.state === 'reserved') {
        if (hasUnexpectedReservationArtifacts(command)) {
          snapshot.needsAttention.push({ commandId: command.id, reason: '未排队命令已有执行或来源关联' })
        } else if (grant.state !== 'active' || grant.expires_at <= now) {
          snapshot.needsAttention.push({ commandId: command.id, reason: '预留命令的授权已暂停或过期' })
        } else {
          snapshot.reservedRecheckCommandIds.push(command.id)
        }
        continue
      }
      if (command.state === 'queued') {
        if (!command.execution_id) {
          snapshot.needsAttention.push({ commandId: command.id, reason: '排队命令缺少执行' })
          continue
        }
        try {
          assertPilotCommandStartRecord(command.execution_id, command.id, grant.policy_revision, now)
          assertPilotExecutionLinked(command.execution_id, grant.policy_revision)
          snapshot.queuedRecheckExecutionIds.push(command.execution_id)
        } catch {
          snapshot.needsAttention.push({ commandId: command.id, reason: '排队命令的授权、来源或执行关联无法核验' })
        }
        continue
      }
      if (command.state === 'running' || command.state === 'needs_reconcile') {
        snapshot.needsAttention.push({ commandId: command.id, reason: '运行结果或费用未知，需人工对账' })
        continue
      }
      if (command.execution_id) {
        const execution = getAgentExecution(command.execution_id)
        if (!execution || execution.pilotCommandId !== command.id || execution.projectId !== grant.project_id
          || execution.status === 'queued' || execution.status === 'running'
          || (command.state === 'released' && (execution.status !== 'cancelled' || execution.sessionId !== ''))) {
          snapshot.needsAttention.push({ commandId: command.id, reason: '终结命令与执行状态不一致' })
        } else {
          try {
            assertPilotExecutionLinked(execution.id, grant.policy_revision)
          } catch {
            snapshot.needsAttention.push({ commandId: command.id, reason: '终结命令的来源关联无法核验' })
          }
        }
      } else if (command.state === 'settled' || hasUnexpectedReservationArtifacts(command)) {
        snapshot.needsAttention.push({ commandId: command.id, reason: '终结命令的执行归属无法核验' })
      }
    }
    const orphanRows = database.prepare(`SELECT e.pilot_command_id AS command_id FROM agent_executions e
      WHERE e.project_id = ? AND e.pilot_command_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pilot_commands c WHERE c.id = e.pilot_command_id)
      UNION
      SELECT l.command_id FROM pilot_command_links l WHERE l.project_id = ?
        AND NOT EXISTS (SELECT 1 FROM pilot_commands c WHERE c.id = l.command_id)
      ORDER BY command_id`).all(grant.project_id, grant.project_id) as Array<{ command_id: string }>
    for (const orphan of orphanRows) {
      snapshot.needsAttention.push({ commandId: orphan.command_id, reason: '项目存在无账本命令的 Pilot 执行或来源关联' })
    }
    result = snapshot
  })()
  if (!result) throw new Error('Pilot 恢复对账未完成')
  return result
}
